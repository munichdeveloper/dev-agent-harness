// Token usage of one coding run, measured where the agent cannot tamper with it: the Claude credential proxy reads the
// usage the API reports in each response; for Codex the runner reads the token counts of the worker's session log.
// The record is written for every run, also for failed, timed-out or budget-stopped ones, so the caller can see what
// a run cost even when it produced nothing.
import { z } from 'zod';
import { insightSchema } from './insight.js';

const count = z.number().int().min(0).max(1e12);
export const tokensSchema = z.strictObject({ input: count, output: count, cacheRead: count, cacheWrite: count });
export type Tokens = z.infer<typeof tokensSchema>;
export const proxyUsageSchema = z.strictObject({
  requests: count, tokens: tokensSchema,
  models: z.record(z.string().regex(/^claude-[a-z0-9.-]{1,80}$/), z.strictObject({ requests: count, tokens: tokensSchema }))
});
export type ProxyUsage = z.infer<typeof proxyUsageSchema>;
export const usageRecordSchema = z.strictObject({
  contractVersion: z.literal('1.0'), executionId: z.string().regex(/^[a-f0-9]{32}$/), worker: z.enum(['codex', 'claude']),
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  // Where the token counts come from: the proxy (Claude), the session log (Codex), or nowhere (null tokens).
  source: z.enum(['proxy', 'codex-session']).nullable(),
  requests: count.nullable(), tokens: tokensSchema.nullable(),
  // Claude Code's own estimate in US dollars; Codex reports none.
  costUsd: z.number().min(0).max(100000).nullable(),
  turns: count.nullable(), durationMs: count.nullable(),
  // How the agent ended: Claude Code's result subtype (e.g. success, error_max_turns, error_max_budget_usd), or null
  // when it was killed before it could report (timeout, crash).
  outcome: z.string().regex(/^[a-z_]{1,60}$/).nullable(),
  budgetUsd: z.number().positive().max(1000).nullable(), budgetReached: z.boolean(),
  // What the run did (tool trace without inputs or outputs, fixed context, change size), for the cost evaluation of the
  // Software Factory. Optional: older brokers and records without it stay valid.
  insight: insightSchema.optional()
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const add = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });
const int = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** The usage of one Messages API response; message_delta carries cumulative counts, so the larger value wins. */
export function responseTokens(events: unknown[]): { model: string | null; tokens: Tokens } | null {
  let model: string | null = null, seen = false;
  const tokens = noTokens();
  const take = (usage: unknown) => {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    seen = true;
    tokens.input = Math.max(tokens.input, int(u.input_tokens));
    tokens.output = Math.max(tokens.output, int(u.output_tokens));
    tokens.cacheRead = Math.max(tokens.cacheRead, int(u.cache_read_input_tokens));
    tokens.cacheWrite = Math.max(tokens.cacheWrite, int(u.cache_creation_input_tokens));
  };
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const e = event as Record<string, unknown>;
    const message = e.type === 'message_start' ? e.message : e.type === 'message' ? e : null;
    if (message && typeof message === 'object') {
      const m = message as Record<string, unknown>;
      if (typeof m.model === 'string') model = m.model;
      take(m.usage);
    } else if (e.type === 'message_delta') take(e.usage);
  }
  return seen ? { model, tokens } : null;
}

/** Reads a streamed (server-sent events) or plain JSON response body chunk by chunk, keeping only usage events. */
export class ResponseReader {
  private events: unknown[] = [];
  private pending = '';
  private plain = '';
  constructor(private readonly stream: boolean, private readonly limit = 4 * 1024 * 1024) {}
  push(chunk: Buffer): void {
    if (!this.stream) { if (this.plain.length < this.limit) this.plain += chunk.toString('utf8'); return; }
    this.pending += chunk.toString('utf8');
    let index: number;
    while ((index = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, index).trimEnd(); this.pending = this.pending.slice(index + 1);
      // Only the usage-bearing events are parsed; content deltas are skipped without decoding.
      if (line.startsWith('data:') && /"type":\s*"message_(start|delta)"/.test(line)) {
        try { this.events.push(JSON.parse(line.slice(5))); } catch { /* a malformed event carries no usage */ }
      }
    }
    if (this.pending.length > this.limit) this.pending = '';
  }
  result(): ReturnType<typeof responseTokens> {
    if (!this.stream) { try { return responseTokens([JSON.parse(this.plain)]); } catch { return null; } }
    return responseTokens(this.events);
  }
}

/** Adds one response to the run's running total. */
export function addResponse(total: ProxyUsage, response: NonNullable<ReturnType<typeof responseTokens>>): ProxyUsage {
  const model = response.model && /^claude-[a-z0-9.-]{1,80}$/.test(response.model) ? response.model : null;
  const models = { ...total.models };
  if (model) {
    const previous = models[model] ?? { requests: 0, tokens: noTokens() };
    models[model] = { requests: previous.requests + 1, tokens: add(previous.tokens, response.tokens) };
  }
  return { requests: total.requests + 1, tokens: add(total.tokens, response.tokens), models };
}
export const emptyProxyUsage = (): ProxyUsage => ({ requests: 0, tokens: noTokens(), models: {} });

/** The last cumulative token count of a Codex session log (rollout-*.jsonl, event_msg token_count). */
export function codexSessionTokens(lines: string[]): { requests: number; tokens: Tokens } | null {
  let last: Record<string, unknown> | null = null, requests = 0;
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const payload = (value as { payload?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } | null } })?.payload;
    if (payload?.type !== 'token_count' || !payload.info?.total_token_usage) continue;
    last = payload.info.total_token_usage; requests += 1;
  }
  if (!last) return null;
  const cached = int(last.cached_input_tokens);
  return { requests, tokens: { input: Math.max(0, int(last.input_tokens) - cached), output: int(last.output_tokens), cacheRead: cached, cacheWrite: 0 } };
}

/** The final result line of Claude Code (--output-format stream-json), as far as it describes cost and outcome. */
export function claudeOutcome(value: unknown): { costUsd: number | null; turns: number | null; durationMs: number | null; outcome: string | null } {
  const empty = { costUsd: null, turns: null, durationMs: null, outcome: null };
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'result') return empty;
  const v = value as Record<string, unknown>;
  const number = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
  return { costUsd: number(v.total_cost_usd), turns: number(v.num_turns) === null ? null : Math.floor(v.num_turns as number),
    durationMs: number(v.duration_ms) === null ? null : Math.floor(v.duration_ms as number),
    outcome: typeof v.subtype === 'string' && /^[a-z_]{1,60}$/.test(v.subtype) ? v.subtype : null };
}
