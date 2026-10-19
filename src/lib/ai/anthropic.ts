// Claude API provider (Ф11 11.B1, ADR-028) on the official SDK.
//
// - No `thinking` parameter: current Claude models think adaptively on their
//   own; how hard is set per feature with `output_config.effort`.
// - Structured answers use `output_config.format` (JSON schema), so a draft is
//   parsed, never scraped out of prose.
// - Server-side refusal fallbacks (`fallbacks: "default"`): a request the model
//   declines on policy grounds is re-run on the fallback Anthropic recommends.
//   Haiku has no server-side fallback, so it is sent only to the models that do.
// - The tool loop is ours: tools run in this process with the asker's rights
//   (modules/ai/ask.ts). Assistant turns go back unchanged (thinking blocks
//   included) so the conversation stays valid; the last turn may not call tools.
// - Every SDK failure is classified into an AiProviderError; the technical
//   reason stays in `cause` for the server log.

import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaUsage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  AiProviderError,
  addUsage,
  NO_USAGE,
  type AiAgentRequest,
  type AiJsonRequest,
  type AiProvider,
  type AiResult,
  type AiTextRequest,
  type AiTokenUsage,
} from './types.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Models that support `fallbacks: "default"` (Claude API). */
const HAS_FALLBACK = /^claude-(opus-5|fable-5|sonnet-5-5|mythos-5)/;

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Per HTTP attempt; the whole operation is bounded by the request's signal. */
  timeoutMs: number;
  /** Tests: a fake transport instead of the network. */
  fetch?: typeof fetch;
}

/** Input, cache and output tokens of a response, every fallback attempt included. */
function usageOf(usage: BetaUsage | undefined): AiTokenUsage {
  if (!usage) return NO_USAGE;
  const attempts = usage.iterations?.length ? usage.iterations : [usage];
  return attempts.reduce<AiTokenUsage>(
    (sum, a) =>
      addUsage(sum, {
        input_tokens:
          (a.input_tokens ?? 0) +
          (a.cache_creation_input_tokens ?? 0) +
          (a.cache_read_input_tokens ?? 0),
        output_tokens: a.output_tokens ?? 0,
      }),
    NO_USAGE,
  );
}

function textOf(content: BetaContentBlock[]): string {
  return content
    .filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function toMessages(request: AiTextRequest): BetaMessageParam[] {
  const history: BetaMessageParam[] = (request.history ?? [])
    .filter((m) => m.text.trim())
    .map((m) => ({ role: m.role, content: m.text }));
  // Documents first, then the text that refers to them.
  const parts = [...request.content].sort(
    (a, b) => Number(b.type === 'pdf') - Number(a.type === 'pdf'),
  );
  const content: BetaContentBlockParam[] = parts.map((part) =>
    part.type === 'pdf'
      ? {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: part.data.toString('base64'),
          },
          title: part.name,
        }
      : { type: 'text', text: part.text },
  );
  return [...history, { role: 'user', content }];
}

/** Turn any SDK or network failure into one of the provider error codes. */
function classify(err: unknown, signal: AbortSignal, usage: AiTokenUsage): AiProviderError {
  if (err instanceof AiProviderError) return err;
  const opts = { usage, cause: err };
  if (
    signal.aborted ||
    err instanceof Anthropic.APIUserAbortError ||
    err instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return new AiProviderError('AI_TIMEOUT', 'The AI service did not answer in time', opts);
  }
  if (err instanceof Anthropic.APIError && err.status === 413) {
    return new AiProviderError('AI_INPUT_TOO_LARGE', 'The input is too large', opts);
  }
  if (err instanceof Anthropic.BadRequestError && /too long|too many|exceed/i.test(err.message)) {
    // The API has no separate error type for an oversized prompt or PDF.
    return new AiProviderError('AI_INPUT_TOO_LARGE', 'The input is too large', opts);
  }
  // Rate limits, overload, 5xx, a bad key or model, network: not the user's fault.
  return new AiProviderError('AI_UNAVAILABLE', 'The AI service is unavailable', opts);
}

/** Refusals and cut-off answers are not usable answers. */
function assertUsable(message: BetaMessage, usage: AiTokenUsage, allowToolUse = false): void {
  if (message.stop_reason === 'refusal') {
    throw new AiProviderError('AI_REFUSED', 'The model declined the request', { usage });
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AiProviderError('AI_BAD_OUTPUT', 'The answer was cut off', { usage });
  }
  if (message.stop_reason === 'tool_use' && !allowToolUse) {
    throw new AiProviderError('AI_BAD_OUTPUT', 'Unexpected tool call', { usage });
  }
}

/** Fallback blocks are audit markers only; they are not sent back. */
const echo = (content: BetaContentBlock[]): BetaContentBlockParam[] =>
  content.filter((b) => b.type !== 'fallback') as BetaContentBlockParam[];

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL && { baseURL: options.baseURL }),
      timeout: options.timeoutMs,
      maxRetries: options.fetch ? 0 : 1,
      ...(options.fetch && { fetch: options.fetch }),
    });
  }

  private base(request: AiTextRequest): MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: toMessages(request),
      output_config: { effort: request.effort },
      ...(HAS_FALLBACK.test(this.model) && {
        betas: [FALLBACK_BETA],
        fallbacks: 'default' as const,
      }),
    };
  }

  private async send(
    params: MessageCreateParamsNonStreaming,
    signal: AbortSignal,
    spent: AiTokenUsage,
  ): Promise<{ message: BetaMessage; usage: AiTokenUsage }> {
    try {
      const message = await this.client.beta.messages.create(params, { signal });
      return { message, usage: addUsage(spent, usageOf(message.usage)) };
    } catch (err) {
      throw classify(err, signal, spent);
    }
  }

  async json(request: AiJsonRequest): Promise<AiResult<unknown>> {
    const params = this.base(request);
    params.output_config = {
      ...params.output_config,
      format: { type: 'json_schema', schema: request.schema },
    };
    const { message, usage } = await this.send(params, request.signal, NO_USAGE);
    assertUsable(message, usage);
    try {
      return { value: JSON.parse(textOf(message.content)), usage, model: message.model };
    } catch (err) {
      throw new AiProviderError('AI_BAD_OUTPUT', 'The answer is not valid JSON', {
        usage,
        cause: err,
      });
    }
  }

  async text(request: AiTextRequest): Promise<AiResult<string>> {
    const { message, usage } = await this.send(this.base(request), request.signal, NO_USAGE);
    assertUsable(message, usage);
    const text = textOf(message.content);
    if (!text) throw new AiProviderError('AI_BAD_OUTPUT', 'The answer is empty', { usage });
    return { value: text, usage, model: message.model };
  }

  async agent(request: AiAgentRequest): Promise<AiResult<string> & { steps: number }> {
    const tools: BetaToolUnion[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as BetaTool['input_schema'],
    }));
    const byName = new Map(request.tools.map((t) => [t.name, t]));
    const params = this.base(request);
    const messages = params.messages;
    let usage = NO_USAGE;

    for (let step = 1; step <= request.maxSteps; step++) {
      const last = step === request.maxSteps;
      const sent = await this.send(
        // The last turn has to answer: tools stay declared (history refers to
        // them) but may not be called.
        { ...params, messages, tools, tool_choice: { type: last ? 'none' : 'auto' } },
        request.signal,
        usage,
      );
      usage = sent.usage;
      const { message } = sent;
      assertUsable(message, usage, true);

      const calls = message.content.filter(
        (b): b is Extract<BetaContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      if (message.stop_reason !== 'tool_use' || calls.length === 0) {
        const text = textOf(message.content);
        if (!text) throw new AiProviderError('AI_BAD_OUTPUT', 'The answer is empty', { usage });
        return { value: text, usage, model: message.model, steps: step };
      }

      messages.push({ role: 'assistant', content: echo(message.content) });
      // Every result of one turn goes back in a single user message.
      const results = await Promise.all(
        calls.map(async (call): Promise<BetaToolResultBlockParam> => {
          const tool = byName.get(call.name);
          if (!tool) {
            return {
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: `Unknown tool: ${call.name}`,
            };
          }
          try {
            return {
              type: 'tool_result',
              tool_use_id: call.id,
              content: await tool.run(call.input),
            };
          } catch (err) {
            return {
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: err instanceof Error ? err.message : 'Tool failed',
            };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    // Unreachable: the last step cannot call tools.
    throw new AiProviderError('AI_BAD_OUTPUT', 'No answer after the tool loop', { usage });
  }
}
