// The Claude API provider (lib/ai/anthropic.ts) on a fake transport: what goes
// over the wire (model, effort, JSON schema, refusal fallbacks, PDF documents,
// the tool loop) and how failures are classified. No network.

import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/lib/ai/anthropic.js';
import { AiProviderError } from '../src/lib/ai/provider.js';

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function message(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2,
    },
    ...extra,
  };
}

/** A fetch that answers the scripted responses in order and records requests. */
function transport(responses: (object | { status: number; body: object })[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const next = responses.shift() ?? message([{ type: 'text', text: 'end' }]);
    const status = 'status' in next && typeof next.status === 'number' ? next.status : 200;
    const body =
      'status' in next && typeof next.status === 'number' ? (next as { body: object }).body : next;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
    });
  }) as typeof fetch;
  return { sent, fetch };
}

const base = {
  system: 'system',
  content: [{ type: 'text' as const, text: 'Вопрос' }],
  maxTokens: 1000,
  effort: 'low' as const,
};

function provider(fetch: typeof globalThis.fetch, model = 'claude-opus-5-5') {
  return new AnthropicProvider({ apiKey: 'test-key', model, timeoutMs: 5000, fetch });
}

describe('Claude provider — requests', () => {
  it('json: schema output, effort, refusal fallbacks, PDF before text, usage summed', async () => {
    const t = transport([message([{ type: 'text', text: '{"ok":true}' }])]);
    const result = await provider(t.fetch).json({
      ...base,
      content: [
        { type: 'text', text: 'Найди поручения' },
        { type: 'pdf', data: Buffer.from('%PDF-1.4'), name: 'Протокол.pdf' },
      ],
      schema: { type: 'object', additionalProperties: false, properties: {} },
      signal: AbortSignal.timeout(5000),
    });
    expect(result).toEqual({
      value: { ok: true },
      usage: { input_tokens: 12, output_tokens: 5 },
      model: 'claude-opus-5-5',
    });
    const [req] = t.sent;
    expect(req!.url).toContain('/v1/messages');
    expect(req!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req!.headers.get('x-api-key')).toBe('test-key');
    expect(req!.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 1000,
      system: 'system',
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(req!.body).not.toHaveProperty('thinking');
    const content = (req!.body.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content.map((c) => c.type)).toEqual(['document', 'text']);
  });

  it('Haiku has no server-side fallback, so none is requested', async () => {
    const t = transport([message([{ type: 'text', text: 'ok' }])]);
    await provider(t.fetch, 'claude-haiku-5-5').text({
      ...base,
      signal: AbortSignal.timeout(5000),
    });
    expect(t.sent[0]!.body).not.toHaveProperty('fallbacks');
    expect(t.sent[0]!.headers.get('anthropic-beta')).toBeNull();
  });

  it('agent: runs tools, echoes the assistant turn unchanged, last turn without tools', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    const t = transport([
      message([thinking, { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'ECON' } }], {
        stop_reason: 'tool_use',
      }),
      message([{ type: 'text', text: 'Готово: ECON-1' }]),
    ]);
    const ran: unknown[] = [];
    const result = await provider(t.fetch).agent({
      ...base,
      tools: [
        {
          name: 'lookup',
          description: 'd',
          input_schema: { type: 'object', properties: { q: { type: 'string' } } },
          run: async (input) => {
            ran.push(input);
            return '{"found":1}';
          },
        },
      ],
      maxSteps: 2,
      signal: AbortSignal.timeout(5000),
    });
    expect(result.value).toBe('Готово: ECON-1');
    expect(result.steps).toBe(2);
    expect(result.usage).toEqual({ input_tokens: 24, output_tokens: 10 });
    expect(ran).toEqual([{ q: 'ECON' }]);
    expect(t.sent[0]!.body.tool_choice).toEqual({ type: 'auto' });
    const second = t.sent[1]!.body;
    expect(second.tool_choice).toEqual({ type: 'none' });
    const messages = second.messages as { role: string; content: unknown[] }[];
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [thinking, { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'ECON' } }],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"found":1}' }],
    });
  });

  it('a failing tool goes back to the model as an error result', async () => {
    const t = transport([
      message([{ type: 'tool_use', id: 'tu_1', name: 'boom', input: {} }], {
        stop_reason: 'tool_use',
      }),
      message([{ type: 'text', text: 'Не удалось' }]),
    ]);
    await provider(t.fetch).agent({
      ...base,
      tools: [
        {
          name: 'boom',
          description: 'd',
          input_schema: { type: 'object' },
          run: async () => {
            throw new Error('outside your area');
          },
        },
      ],
      maxSteps: 3,
      signal: AbortSignal.timeout(5000),
    });
    const results = (t.sent[1]!.body.messages as { content: unknown[] }[])[2]!.content;
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'outside your area' },
    ]);
  });
});

describe('Claude provider — failures', () => {
  const expectCode = async (promise: Promise<unknown>, code: string) => {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).code).toBe(code);
  };

  it('a refusal is AI_REFUSED, a cut-off answer AI_BAD_OUTPUT', async () => {
    const refused = transport([message([], { stop_reason: 'refusal' })]);
    await expectCode(
      provider(refused.fetch).text({ ...base, signal: AbortSignal.timeout(5000) }),
      'AI_REFUSED',
    );
    const cut = transport([
      message([{ type: 'text', text: '{"a":' }], { stop_reason: 'max_tokens' }),
    ]);
    await expectCode(
      provider(cut.fetch).json({ ...base, schema: {}, signal: AbortSignal.timeout(5000) }),
      'AI_BAD_OUTPUT',
    );
  });

  it('overload is AI_UNAVAILABLE, an oversized prompt AI_INPUT_TOO_LARGE, a deadline AI_TIMEOUT', async () => {
    const overloaded = transport([
      {
        status: 529,
        body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      },
    ]);
    await expectCode(
      provider(overloaded.fetch).text({ ...base, signal: AbortSignal.timeout(5000) }),
      'AI_UNAVAILABLE',
    );
    const tooLong = transport([
      {
        status: 400,
        body: {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'prompt is too long' },
        },
      },
    ]);
    await expectCode(
      provider(tooLong.fetch).text({ ...base, signal: AbortSignal.timeout(5000) }),
      'AI_INPUT_TOO_LARGE',
    );
    const aborted = new AbortController();
    aborted.abort();
    const t = transport([message([{ type: 'text', text: 'late' }])]);
    await expectCode(provider(t.fetch).text({ ...base, signal: aborted.signal }), 'AI_TIMEOUT');
  });
});
