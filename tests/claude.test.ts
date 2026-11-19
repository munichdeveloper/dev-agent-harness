import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { forwardHeaders, logText, maxRequestBytes, oauthBeta, proxyOptions, refusal, startProxy, upstreamErrorLine } from '../src/claude-proxy.js';
import { rejectionReason } from '../src/rejection.js';
import { claudeMessage, codingPrompt, codingRequestSchema } from '../src/coding.js';

const request = { contractVersion: '3.0', executionId: 'a'.repeat(32), worker: 'claude',
  task: { id: 'opaque:task-1', version: 'b'.repeat(64), description: 'Fix the bug', acceptanceCriteria: ['Tests pass'], contextReferences: [] },
  allowedActions: ['edit_workspace', 'run_commands'], baseSha: 'c'.repeat(40), model: 'claude-opus-5-5', effort: 'high',
  limits: { timeoutMinutes: 30, maxFiles: 100, maxPatchBytes: 5000000 } };
const body = (value: unknown) => Buffer.from(JSON.stringify(value));
const messages = { model: 'claude-opus-5-5', max_tokens: 10, messages: [], tools: [{ name: 'Bash', input_schema: {} }, { name: 'Edit', type: 'custom', input_schema: {} }] };

it('accepts Claude requests with Claude models and max effort only for Claude', () => {
  expect(codingRequestSchema.safeParse(request).success).toBe(true);
  expect(codingRequestSchema.safeParse({ ...request, effort: 'max' }).success).toBe(true);
  expect(codingRequestSchema.safeParse({ ...request, model: 'gpt-6.1-sol' }).success).toBe(false);
  expect(codingRequestSchema.safeParse({ ...request, worker: 'codex', model: 'gpt-6.1-sol', effort: 'max' }).success).toBe(false);
  expect(codingRequestSchema.safeParse({ ...request, worker: 'other' }).success).toBe(false);
  expect(codingPrompt(request)).toContain('.claude/');
  expect(codingPrompt(request)).toContain('CLAUDE.md');
});
it('takes the message only from a successful result with a valid structured output', () => {
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'x', structured_output: { status: 'success', summary: 'Done' } };
  expect(claudeMessage(result)).toEqual({ status: 'success', summary: 'Done' });
  expect(() => claudeMessage({ ...result, is_error: true })).toThrow();
  expect(() => claudeMessage({ ...result, structured_output: undefined })).toThrow();
  expect(() => claudeMessage({ ...result, structured_output: { status: 'merged', summary: 'Done' } })).toThrow();
  expect(() => claudeMessage({ ...result, type: 'assistant' })).toThrow();
});
it('forwards only model requests without server tools or remote servers', () => {
  expect(refusal('POST', '/v1/messages?beta=true', {}, body(messages))).toBeNull();
  expect(refusal('POST', '/v1/messages', {}, body(messages))).toBeNull();
  expect(refusal('POST', '/v1/messages/count_tokens?beta=true', {}, body(messages))).toBeNull();
  expect(refusal('GET', '/v1/messages', {}, body(messages))).toBe('method');
  for (const path of ['/v1/models', '/v1/files', '/v1/messages/batches', '/v1/messages/../files', '/api/oauth']) expect(refusal('POST', path, {}, body(messages))).toBe('path');
  expect(refusal('POST', '/v1/messages?beta=true&x=1', {}, body(messages))).toBe('query');
  expect(refusal('POST', '/v1/messages', { 'content-encoding': 'gzip' }, body(messages))).toBe('encoding');
  expect(refusal('POST', '/v1/messages', {}, Buffer.from('{'))).toBe('json');
  expect(refusal('POST', '/v1/messages', {}, body([]))).toBe('json');
  expect(refusal('POST', '/v1/messages', {}, body({ ...messages, model: 'gpt-6.1-sol' }))).toBe('model');
  expect(refusal('POST', '/v1/messages', {}, body({ ...messages, mcp_servers: [{ url: 'https://example.invalid' }] }))).toBe('remote');
  expect(refusal('POST', '/v1/messages', {}, body({ ...messages, container: 'c' }))).toBe('remote');
  for (const type of ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250825', 'bash_20250124'])
    expect(refusal('POST', '/v1/messages', {}, body({ ...messages, tools: [...messages.tools, { type, name: 'x' }] }))).toBe('server-tool');
  expect(refusal('POST', '/v1/messages', {}, Buffer.alloc(maxRequestBytes + 1, 32))).toBe('size');
});
it('replaces any client credential with the proxy key and drops unlisted headers', () => {
  const headers = forwardHeaders({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'placeholder',
    authorization: 'Bearer stolen', host: 'evil.invalid', cookie: 'a=b' }, { kind: 'api-key', value: 'sk-ant-real' }, 12);
  expect(headers).toEqual({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant-real', 'content-length': '12' });
});
it('sends a subscription OAuth token as bearer token with the OAuth beta flag, never as x-api-key', () => {
  const credential = { kind: 'oauth' as const, value: 'sk-ant-oat01-real' };
  const headers = forwardHeaders({ 'content-type': 'application/json', 'x-api-key': 'placeholder', authorization: 'Bearer harness-proxy-placeholder',
    'anthropic-beta': `claude-code-20250219,${oauthBeta}` }, credential, 5);
  expect(headers).toEqual({ 'content-type': 'application/json', 'anthropic-beta': `claude-code-20250219,${oauthBeta}`, authorization: 'Bearer sk-ant-oat01-real', 'content-length': '5' });
  expect(forwardHeaders({ 'anthropic-beta': 'a-1' }, credential, 1)['anthropic-beta']).toBe(`a-1,${oauthBeta}`);
  expect(forwardHeaders({}, credential, 1)['anthropic-beta']).toBe(oauthBeta);
});
it('runs either Codex or Claude Code, each with its own credential and account', async () => {
  const action = parse(await readFile('action.yml', 'utf8'));
  expect(action.inputs['openai-api-key'].required).toBe(false);
  expect(action.inputs['anthropic-api-key'].default).toBe('');
  const steps = action.runs.steps as { name?: string; if?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> }[];
  expect(steps.find(step => step.uses?.startsWith('openai/codex-action@'))?.if).toBe("steps.prepare.outputs.worker == 'codex'");
  expect(steps.find(step => step.name === 'Seed the Codex home with an untrusted checkout')?.if).toBe("steps.prepare.outputs.worker == 'codex'");
  const claude = steps.find(step => step.name === 'Run Claude Code behind the credential proxy')!;
  expect(claude.if).toBe("steps.prepare.outputs.worker == 'claude'");
  expect(claude.env?.HARNESS_ANTHROPIC_API_KEY).toBe('${{ inputs.anthropic-api-key }}');
  expect(claude.env?.HARNESS_CLAUDE_OAUTH_TOKEN).toBe('${{ inputs.claude-oauth-token }}');
  expect(action.inputs['claude-oauth-token'].default).toBe('');
  expect(claude.env?.CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  // Only the Claude step sees the Anthropic key, only the Codex Action the OpenAI key.
  for (const step of steps) {
    const text = JSON.stringify(step);
    if (step !== claude) expect(text).not.toContain('inputs.anthropic-api-key }}');
    if (step !== claude) expect(text).not.toContain('inputs.claude-oauth-token }}');
    if (!step.uses?.startsWith('openai/codex-action@')) expect(text).not.toContain('inputs.openai-api-key }}');
  }
  const script = await readFile('scripts/claude-run.sh', 'utf8');
  for (const part of ['--strict-mcp-config', '--disallowedTools WebFetch WebSearch', '--setting-sources user', 'unset HARNESS_ANTHROPIC_API_KEY',
    'ANTHROPIC_API_KEY=harness-proxy-placeholder', 'Network isolation of the Claude worker failed']) expect(script).toContain(part);
});
it('reads the key and allows only a loopback stand-in as upstream', () => {
  const key = 'sk-ant-fixture-not-a-real-key-0123456789';
  expect(proxyOptions({ HARNESS_ANTHROPIC_API_KEY: key })).toEqual({ credential: { kind: 'api-key', value: key }, upstream: { secure: true, host: 'api.anthropic.com', port: 443 } });
  expect(proxyOptions({ HARNESS_CLAUDE_OAUTH_TOKEN: key }).credential).toEqual({ kind: 'oauth', value: key });
  expect(proxyOptions({ HARNESS_ANTHROPIC_API_KEY: '', HARNESS_CLAUDE_OAUTH_TOKEN: key }).credential.kind).toBe('oauth');
  expect(() => proxyOptions({ HARNESS_ANTHROPIC_API_KEY: key, HARNESS_CLAUDE_OAUTH_TOKEN: key })).toThrow('either');
  expect(() => proxyOptions({ HARNESS_CLAUDE_OAUTH_TOKEN: 'short' })).toThrow('key');
  expect(proxyOptions({ HARNESS_ANTHROPIC_API_KEY: key, HARNESS_PROXY_UPSTREAM: 'http://127.0.0.1:8080' }).upstream).toEqual({ secure: false, host: '127.0.0.1', port: 8080 });
  for (const upstream of ['http://example.com:80', 'https://127.0.0.1:1', 'http://127.0.0.1:0', 'http://127.0.0.1:1/x'])
    expect(() => proxyOptions({ HARNESS_ANTHROPIC_API_KEY: key, HARNESS_PROXY_UPSTREAM: upstream })).toThrow('upstream');
  for (const bad of [undefined, '', 'short', `${key} with space`]) expect(() => proxyOptions({ HARNESS_ANTHROPIC_API_KEY: bad })).toThrow('key');
});
it('forwards allowed requests with the real key and answers refused ones itself', async () => {
  const seen: { url?: string; key?: string | string[]; body: string }[] = [];
  const upstream = createServer((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
    seen.push({ url: req.url, key: req.headers['x-api-key'], body }); res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end('{"ok":true}'); }); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const key = 'sk-ant-fixture-not-a-real-key-0123456789';
  const proxy = await startProxy({ credential: { kind: 'api-key', value: key }, upstream: { secure: false, host: '127.0.0.1', port: (upstream.address() as AddressInfo).port } });
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'placeholder' }, body: JSON.stringify(messages) });
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ url: '/v1/messages?beta=true', key, body: JSON.stringify(messages) }]);
    const refused = await fetch(`${url}/v1/files`, { method: 'POST', body: '{}' });
    expect(refused.status).toBe(403); expect((await refused.json()).error.message).toContain('path');
    expect(seen).toHaveLength(1);
    upstream.close(); upstream.closeAllConnections();
    const down = await fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify(messages) });
    expect(down.status).toBe(502);
  } finally { proxy.close(); upstream.close(); }
});
it('logs why an upstream answer failed without anything but the API error', () => {
  expect(upstreamErrorLine(400, '/v1/messages', JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } })))
    .toBe('Upstream 400 /v1/messages: invalid_request_error: Your credit balance is too low');
  expect(upstreamErrorLine(529, '/v1/messages', 'not json')).toBe('Upstream 529 /v1/messages');
  expect(upstreamErrorLine(429, '/v1/messages', JSON.stringify({ error: { type: 'rate_limit_error', message: 'a\nb'.repeat(200) } })))
    .toMatch(/^Upstream 429 \/v1\/messages: rate_limit_error: a b.{290,}\.\.\.$/);
  expect(logText('x\u0000y\u001b[31m z')).toBe('x y [31m z');
});
it('names the reason an artifact was rejected without echoing worker values', () => {
  const missing = (() => { try { claudeMessage({ type: 'result', is_error: false }); } catch (error) { return error; } })();
  expect(rejectionReason(missing)).toBe('structured_output: Invalid input: expected nonoptional, received undefined');
  const failed = (() => { try { claudeMessage({ type: 'result', is_error: true, structured_output: { status: 'success', summary: 'secret' } }); } catch (error) { return error; } })();
  expect(rejectionReason(failed)).toMatch(/^is_error: /);
  expect(rejectionReason(failed)).not.toContain('secret');
  expect(rejectionReason(new Error('Too many changed files'))).toBe('Too many changed files');
  expect(rejectionReason(Object.assign(new Error('ENOENT: /x'), { code: 'ENOENT' }))).toBe('file missing');
  expect(rejectionReason(new SyntaxError('Unexpected token'))).toBe('invalid JSON');
  expect(rejectionReason('x')).toBe('unknown error');
});
