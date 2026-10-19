// AI module core (Ф11 11.B1, ADR-028): who may use the assistant, the daily
// limit, and the usage log around every provider call.
//
// Every feature goes through `runAi`:
//   1. AI is on for this server and the caller is not a guest (AI_DISABLED);
//   2. the caller has requests left today (AI_LIMIT_REACHED, 429);
//   3. the provider call runs under one deadline (AI_TIMEOUT_MS);
//   4. a row goes to AiUsage — feature, model, tokens, duration, result. The
//      texts of the request and of the answer are never written there.
// Provider failures become client errors with stable codes; the technical reason
// is logged on the server only.

import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient, Workspace, WorkspaceMember } from '@prisma/client';
import { config } from '../../config/index.js';
import { AppError } from '../../lib/errors.js';
import { addDays, localDate, startOfLocalDay } from '../../lib/tz.js';
import {
  AiProviderError,
  aiProvider,
  NO_USAGE,
  type AiFeature,
  type AiProvider,
  type AiProviderErrorCode,
  type AiResult,
} from '../../lib/ai/provider.js';

export interface AiContext {
  prisma: PrismaClient;
  workspace: Pick<Workspace, 'id' | 'name' | 'short_name' | 'timezone' | 'slug'>;
  member: WorkspaceMember;
  log: FastifyBaseLogger;
}

export interface AiQuota {
  limit: number;
  used: number;
  remaining: number;
  /** When the counter starts again: next midnight in the workspace zone. */
  resets_at: Date;
}

/** Off on this server, or a guest asking: both look the same to the client. */
export function assertAiAvailable(member: Pick<WorkspaceMember, 'role'>): void {
  if (!config.AI_ENABLED) {
    throw new AppError(404, 'AI_DISABLED', 'The AI assistant is turned off on this server');
  }
  if (member.role === 'guest') {
    throw new AppError(404, 'AI_DISABLED', 'The AI assistant is not available to guests');
  }
}

/** Successful requests of the user since midnight in the workspace zone (all workspaces). */
export async function quotaOf(
  prisma: PrismaClient,
  userId: string,
  timeZone: string,
): Promise<AiQuota> {
  const today = localDate(new Date(), timeZone);
  const used = await prisma.aiUsage.count({
    where: { user_id: userId, status: 'ok', created_at: { gte: startOfLocalDay(today, timeZone) } },
  });
  const limit = config.AI_DAILY_LIMIT;
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resets_at: startOfLocalDay(addDays(today, 1), timeZone),
  };
}

/** `GET WS/ai/status`: what the UI needs to show or hide the assistant. */
export async function status(ctx: AiContext) {
  if (!config.AI_ENABLED || ctx.member.role === 'guest') return { enabled: false as const };
  const quota = await quotaOf(ctx.prisma, ctx.member.user_id, ctx.workspace.timezone);
  return {
    enabled: true as const,
    provider: config.AI_PROVIDER,
    model: aiProvider().model,
    daily_limit: quota.limit,
    used_today: quota.used,
    remaining_today: quota.remaining,
    resets_at: quota.resets_at,
  };
}

const PROVIDER_ERRORS: Record<AiProviderErrorCode, { status: number; message: string }> = {
  AI_TIMEOUT: { status: 504, message: 'The AI service did not answer in time' },
  AI_UNAVAILABLE: { status: 503, message: 'The AI service is unavailable right now' },
  AI_REFUSED: { status: 422, message: 'The AI model declined this request' },
  AI_BAD_OUTPUT: { status: 502, message: 'The AI answer could not be used' },
  AI_INPUT_TOO_LARGE: { status: 413, message: 'The text or file is too large for the AI service' },
};

/**
 * Run one AI operation for the caller: availability, limit, deadline, usage log.
 * `call` gets the provider and the deadline signal and may also do its own work
 * (tool calls in the caller's rights) inside the deadline.
 */
export async function runAi<T>(
  ctx: AiContext,
  feature: AiFeature,
  call: (provider: AiProvider, signal: AbortSignal) => Promise<AiResult<T>>,
): Promise<AiResult<T>> {
  assertAiAvailable(ctx.member);
  const userId = ctx.member.user_id;
  const quota = await quotaOf(ctx.prisma, userId, ctx.workspace.timezone);
  if (quota.remaining <= 0) {
    throw new AppError(429, 'AI_LIMIT_REACHED', 'The daily AI request limit is used up', {
      limit: quota.limit,
      used: quota.used,
      resets_at: quota.resets_at,
    });
  }

  const provider = aiProvider();
  const started = Date.now();
  const signal = AbortSignal.timeout(config.AI_TIMEOUT_MS);
  const record = async (row: {
    status: 'ok' | 'error';
    model: string;
    input_tokens: number;
    output_tokens: number;
    error_code?: string;
  }) => {
    try {
      await ctx.prisma.aiUsage.create({
        data: {
          workspace_id: ctx.workspace.id,
          user_id: userId,
          feature,
          provider: provider.name,
          duration_ms: Date.now() - started,
          ...row,
        },
      });
    } catch (err) {
      // The log must never turn a served answer into an error.
      ctx.log.error({ err, feature }, 'AI usage log write failed');
    }
  };

  try {
    const result = await call(provider, signal);
    await record({ status: 'ok', model: result.model, ...result.usage });
    return result;
  } catch (err) {
    const usage = err instanceof AiProviderError ? err.usage : NO_USAGE;
    const code =
      err instanceof AiProviderError || err instanceof AppError ? err.code : 'INTERNAL_ERROR';
    await record({ status: 'error', model: provider.model, error_code: code, ...usage });
    if (err instanceof AiProviderError) {
      ctx.log.warn({ err: err.cause ?? err, feature, code }, 'AI request failed');
      const { status: httpStatus, message } = PROVIDER_ERRORS[err.code];
      throw new AppError(httpStatus, err.code, message);
    }
    throw err;
  }
}
