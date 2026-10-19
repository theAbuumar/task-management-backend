// Types shared by the AI provider interface and its implementations (Ф11, ADR-028).

/** What the request is for: the usage log and the daily limit count by it. */
export type AiFeature = 'draft_issues' | 'summary' | 'report' | 'ask' | 'bot_draft';

/** How hard the model thinks: cheap and quick for a summary, deeper for a memo. */
export type AiEffort = 'low' | 'medium' | 'high';

export type AiPart =
  | { type: 'text'; text: string }
  /** A PDF the model reads itself, scanned pages included. */
  | { type: 'pdf'; data: Buffer; name: string };

export interface AiTokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export const NO_USAGE: AiTokenUsage = Object.freeze({ input_tokens: 0, output_tokens: 0 });

export interface AiTextRequest {
  system: string;
  /** Earlier turns of a dialogue, as plain text. */
  history?: { role: 'user' | 'assistant'; text: string }[];
  /** The current user turn. */
  content: AiPart[];
  maxTokens: number;
  effort: AiEffort;
  /** Aborts the whole operation at the deadline (AI_TIMEOUT_MS). */
  signal: AbortSignal;
}

export interface AiJsonRequest extends AiTextRequest {
  /** JSON Schema of the answer. Every object needs `additionalProperties: false`. */
  schema: Record<string, unknown>;
}

export interface AiTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /**
   * Runs in the asker's rights and returns what the model reads. A thrown error
   * goes back to the model as a failed tool result, not to the user.
   */
  run(input: unknown): Promise<string>;
}

export interface AiAgentRequest extends AiTextRequest {
  tools: AiTool[];
  /** Model turns at most; the last one must answer without tools. */
  maxSteps: number;
}

export interface AiResult<T> {
  value: T;
  usage: AiTokenUsage;
  /** The model that produced the answer (a fallback model after a refusal). */
  model: string;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  json(request: AiJsonRequest): Promise<AiResult<unknown>>;
  text(request: AiTextRequest): Promise<AiResult<string>>;
  agent(request: AiAgentRequest): Promise<AiResult<string> & { steps: number }>;
}

export type AiProviderErrorCode =
  | 'AI_TIMEOUT'
  | 'AI_UNAVAILABLE'
  | 'AI_REFUSED'
  | 'AI_BAD_OUTPUT'
  | 'AI_INPUT_TOO_LARGE';

/**
 * A provider failure, already classified. `usage` is what the failed call still
 * consumed; `cause` keeps the technical reason for the server log only.
 */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly usage: AiTokenUsage;

  constructor(
    code: AiProviderErrorCode,
    message: string,
    options: { usage?: AiTokenUsage; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AiProviderError';
    this.code = code;
    this.usage = options.usage ?? NO_USAGE;
  }
}

export function addUsage(a: AiTokenUsage, b: AiTokenUsage): AiTokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}
