import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startProxy } from '../src/claude-proxy.js';
import { addResponse, claudeOutcome, codexSessionTokens, emptyProxyUsage, ResponseReader, responseTokens, usageRecordSchema } from '../src/usage.js';

const sse = (...events: object[]) => events.map(e => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');

it('reads usage from streamed and plain responses', () => {
  const stream = new ResponseReader(true);
  const body = sse({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 40, output_tokens: 1 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '"type":"message_delta" in text' } },
    { type: 'message_delta', usage: { output_tokens: 120 } }, { type: 'message_stop' });
  // Split mid-line: the reader keeps the incomplete line until the next chunk.
  stream.push(Buffer.from(body.slice(0, 37))); stream.push(Buffer.from(body.slice(37)));
  expect(stream.result()).toEqual({ model: 'claude-opus-5-5', tokens: { input: 10, output: 120, cacheRead: 500, cacheWrite: 40 } });
  const plain = new ResponseReader(false);
  plain.push(Buffer.from(JSON.stringify({ type: 'message', model: 'claude-sonnet-5-5', usage: { input_tokens: 3, output_tokens: 4 } })));
  expect(plain.result()).toEqual({ model: 'claude-sonnet-5-5', tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 } });
  expect(new ResponseReader(false).result()).toBeNull();
  expect(responseTokens([{ type: 'ping' }])).toBeNull();
});
it('adds responses per model and in total', () => {
  let total = emptyProxyUsage();
  total = addResponse(total, { model: 'claude-opus-5-5', tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  total = addResponse(total, { model: 'claude-opus-5-5', tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  total = addResponse(total, { model: 'not a model', tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
  expect(total).toEqual({ requests: 3, tokens: { input: 3, output: 4, cacheRead: 6, cacheWrite: 8 },
    models: { 'claude-opus-5-5': { requests: 2, tokens: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8 } } } });
});
it('takes the last cumulative count of a Codex session', () => {
  const line = (input: number, cached: number, output: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } } });
  expect(codexSessionTokens([line(100, 20, 5), 'not json', JSON.stringify({ payload: { type: 'token_count', info: null } }), line(300, 200, 50)]))
    .toEqual({ requests: 2, tokens: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0 } });
  expect(codexSessionTokens(['{}'])).toBeNull();
});
it('reads cost and outcome from the Claude Code result line only', () => {
  expect(claudeOutcome({ type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 10.02, num_turns: 41, duration_ms: 612000.4 }))
    .toEqual({ costUsd: 10.02, turns: 41, durationMs: 612000, outcome: 'error_max_budget_usd' });
  expect(claudeOutcome({ type: 'assistant' })).toEqual({ costUsd: null, turns: null, durationMs: null, outcome: null });
  expect(claudeOutcome({ type: 'result', subtype: 'Bad Value', total_cost_usd: -1 }).outcome).toBeNull();
  expect(usageRecordSchema.safeParse({ contractVersion: '1.0', executionId: 'a'.repeat(32), worker: 'claude', model: 'claude-opus-5-5', effort: 'high',
    source: null, requests: null, tokens: null, costUsd: null, turns: null, durationMs: null, outcome: null, budgetUsd: null, budgetReached: false }).success).toBe(true);
});
it('meters billed responses through the proxy and writes the running total', async () => {
  const upstream = createServer((req, res) => { req.resume(); req.on('end', () => {
    if (req.url?.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":99}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 7, output_tokens: 1 } } }, { type: 'message_delta', usage: { output_tokens: 9 } }));
  }); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const usageFile = join(await mkdtemp(join(tmpdir(), 'usage-')), 'proxy-usage.json');
  const seen: number[] = [];
  const proxy = await startProxy({ credential: { kind: 'api-key', value: 'sk-ant-fixture-not-a-real-key-0123456789' }, usageFile,
    upstream: { secure: false, host: '127.0.0.1', port: (upstream.address() as AddressInfo).port } }, usage => seen.push(usage.requests));
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const body = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [] });
  try {
    for (const path of ['/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens']) await (await fetch(url + path, { method: 'POST', body })).text();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(seen).toEqual([1, 2]);
    expect(JSON.parse(await readFile(usageFile, 'utf8'))).toEqual({ requests: 2, tokens: { input: 14, output: 18, cacheRead: 0, cacheWrite: 0 },
      models: { 'claude-opus-5-5': { requests: 2, tokens: { input: 14, output: 18, cacheRead: 0, cacheWrite: 0 } } } });
  } finally { proxy.close(); upstream.close(); }
});
it('prepares the budget and records usage for a failed run without a result line', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile, mkdir } = await import('node:fs/promises');
  const temp = await mkdtemp(join(tmpdir(), 'usage-cli-')), id = 'd'.repeat(32), directory = join(temp, `harness-${id}`);
  const request = { contractVersion: '3.0', executionId: id, worker: 'claude',
    task: { id: 'opaque:1', version: 'b'.repeat(64), description: 'x', acceptanceCriteria: ['y'], contextReferences: [] },
    allowedActions: ['edit_workspace', 'run_commands'], baseSha: 'c'.repeat(40), model: 'claude-opus-5-5', effort: 'high',
    limits: { timeoutMinutes: 30, maxFiles: 100, maxPatchBytes: 5000000, maxCostUsd: 7.5 } };
  const env = { ...process.env, RUNNER_TEMP: temp, HARNESS_EXECUTION_ID: id, HARNESS_REQUEST: JSON.stringify(request), GITHUB_OUTPUT: join(temp, 'out') };
  execFileSync('node', ['dist/coding-cli.js', 'prepare'], { env });
  expect(await readFile(join(temp, 'out'), 'utf8')).toContain('budget=7.5\n');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'proxy-usage.json'), JSON.stringify({ requests: 4, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, models: {} }));
  const log = execFileSync('node', ['dist/coding-cli.js', 'usage'], { env, encoding: 'utf8' });
  expect(log).toContain('requests=4 input=1 output=2 cache_read=3 cache_write=4 cost_usd=- turns=- outcome=- budget_usd=7.5');
  expect(JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'))).toMatchObject({ worker: 'claude', source: 'proxy', requests: 4,
    costUsd: null, outcome: null, budgetUsd: 7.5, budgetReached: false });
  await writeFile(join(directory, 'claude.json'), JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 7.6, num_turns: 30, duration_ms: 1000 }));
  execFileSync('node', ['dist/coding-cli.js', 'usage'], { env });
  expect(JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8'))).toMatchObject({ costUsd: 7.6, turns: 30, outcome: 'error_max_budget_usd', budgetReached: true });
});
