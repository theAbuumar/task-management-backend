// AI provider abstraction (Ф11 11.B1, ADR-016, ADR-028).
//
// Services never talk to a vendor SDK. They ask the provider for one of three
// things:
//   - `json`  — an answer that matches a JSON schema (structured output);
//   - `text`  — a plain answer;
//   - `agent` — an answer from a tool loop whose tools run here, in the rights of
//     the person who asked.
// The Claude API is the first implementation (lib/ai/anthropic.ts). Another
// provider is another class behind the same interface. Tests swap in a fake with
// `setAiProvider`.

import { config } from '../../config/index.js';
import { AnthropicProvider } from './anthropic.js';
import type { AiProvider } from './types.js';

export * from './types.js';

let override: AiProvider | null = null;
let instance: AiProvider | null = null;

/** Tests: serve every AI request with `provider` (null restores the configured one). */
export function setAiProvider(provider: AiProvider | null): void {
  override = provider;
}

/** The configured provider (created on first use; callers check AI_ENABLED first). */
export function aiProvider(): AiProvider {
  if (override) return override;
  if (!instance) {
    instance = new AnthropicProvider({
      apiKey: config.AI_API_KEY ?? '',
      model: config.AI_MODEL,
      baseURL: config.AI_BASE_URL,
      timeoutMs: config.AI_TIMEOUT_MS,
    });
  }
  return instance;
}
