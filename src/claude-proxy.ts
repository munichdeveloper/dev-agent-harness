// Credential proxy for one Claude run. It runs as the runner account, holds the Anthropic key and listens on
// 127.0.0.1 only; the worker account gets the proxy address and a placeholder key, so the key is never readable by
// the agent or its commands. Only model requests pass: no other endpoint, and no server-side tool (web search, web
// fetch, code execution) or remote MCP server, because those would reach the network on the agent's behalf.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { renameSync, writeFileSync } from 'node:fs';
import { addResponse, emptyProxyUsage, ResponseReader, type ProxyUsage } from './usage.js';

export const proxyPaths = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const forwardedHeaders = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'user-agent', 'x-app'];
export const maxRequestBytes = 32 * 1024 * 1024;

/** Returns the reason a request is refused, or null when it may be forwarded. */
export function refusal(method: string | undefined, url: string | undefined, headers: IncomingHttpHeaders, body: Buffer): string | null {
  if (method !== 'POST') return 'method';
  const parsed = new URL(url ?? '', 'http://127.0.0.1');
  if (!proxyPaths.has(parsed.pathname)) return 'path';
  for (const [key, value] of parsed.searchParams) if (key !== 'beta' || value !== 'true') return 'query';
  if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') return 'encoding';
  if (body.length > maxRequestBytes) return 'size';
  let payload: unknown;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return 'json'; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'json';
  const fields = payload as Record<string, unknown>;
  if ('mcp_servers' in fields || 'container' in fields) return 'remote';
  if (typeof fields.model !== 'string' || !/^claude-[a-z0-9.-]{1,80}$/.test(fields.model)) return 'model';
  if (fields.tools !== undefined) {
    if (!Array.isArray(fields.tools)) return 'tools';
    // Client tools have no type or type "custom"; every other type is executed by the API server.
    for (const tool of fields.tools) {
      if (!tool || typeof tool !== 'object') return 'tools';
      const type = (tool as Record<string, unknown>).type;
      if (type !== undefined && type !== 'custom') return 'server-tool';
    }
  }
  return null;
}

export function forwardHeaders(headers: IncomingHttpHeaders, key: string, length: number): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of forwardedHeaders) { const value = headers[name]; if (typeof value === 'string') result[name] = value; }
  return { ...result, 'x-api-key': key, 'content-length': String(length) };
}

/** Printable single-line text, bounded, for diagnostics in the job log. */
export function logText(value: string, limit = 300): string {
  const text = value.replace(/[^\x20-\x7e]+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/**
 * One log line for an upstream answer that is not a success, so a run that stops on an API error (credit, rate limit,
 * invalid request) says why. Only the API's error type and message are kept; they carry no credential.
 */
export function upstreamErrorLine(status: number, path: string, body: string): string {
  let detail = '';
  try {
    const error = (JSON.parse(body) as { error?: { type?: unknown; message?: unknown } }).error;
    if (error && typeof error === 'object') {
      detail = [error.type, error.message].filter((x): x is string => typeof x === 'string').map(x => logText(x)).join(': ');
    }
  } catch { /* not JSON */ }
  return `Upstream ${status} ${path}${detail ? `: ${detail}` : ''}`;
}

export interface ProxyOptions { key: string; upstream: { secure: boolean; host: string; port: number }; usageFile?: string }
/** Parses the run's configuration; the upstream is the Anthropic API unless a test names a stand-in on this host's loopback. */
export function proxyOptions(env: Record<string, string | undefined>): ProxyOptions {
  const key = env.HARNESS_ANTHROPIC_API_KEY ?? '';
  if (!/^[\x21-\x7e]{20,300}$/.test(key)) throw new Error('Proxy key rejected');
  const usageFile = env.HARNESS_PROXY_USAGE_FILE ? { usageFile: env.HARNESS_PROXY_USAGE_FILE } : {};
  if (!env.HARNESS_PROXY_UPSTREAM) return { key, upstream: { secure: true, host: 'api.anthropic.com', port: 443 }, ...usageFile };
  const local = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(env.HARNESS_PROXY_UPSTREAM);
  if (!local) throw new Error('Proxy upstream rejected');
  return { key, upstream: { secure: false, host: '127.0.0.1', port: Number(local[1]) }, ...usageFile };
}
export function startProxy({ key, upstream: target, usageFile }: ProxyOptions, onUsage?: (usage: ProxyUsage) => void): Promise<Server> {
  const send = target.secure ? httpsRequest : httpRequest;
  // The running total of the usage the API reported, rewritten after every response so a killed run still leaves it.
  let usage = emptyProxyUsage();
  const record = (reader: ResponseReader) => {
    const response = reader.result();
    if (!response) return;
    usage = addResponse(usage, response);
    if (usageFile) { writeFileSync(`${usageFile}.tmp`, JSON.stringify(usage), { mode: 0o644 }); renameSync(`${usageFile}.tmp`, usageFile); }
    onUsage?.(usage);
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxRequestBytes) { req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks), reason = refusal(req.method, req.url, req.headers, body);
      if (reason) {
        console.log(`Refused ${req.method} ${new URL(req.url ?? '', 'http://127.0.0.1').pathname}: ${reason}`);
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: `Refused by the harness proxy: ${reason}` } }));
        return;
      }
      const upstream = send({ host: target.host, port: target.port, method: 'POST', path: req.url,
        headers: forwardHeaders(req.headers, key, body.length), timeout: 600000 }, response => {
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding'].includes(name)) headers[name] = value;
        }
        res.writeHead(response.statusCode ?? 502, headers);
        // Billed responses only: successful Messages calls (count_tokens is free).
        if (response.statusCode === 200 && new URL(req.url ?? '', 'http://127.0.0.1').pathname === '/v1/messages') {
          const reader = new ResponseReader(String(response.headers['content-type'] ?? '').startsWith('text/event-stream'));
          response.on('data', (chunk: Buffer) => reader.push(chunk));
          response.on('end', () => { try { record(reader); } catch { /* metering never breaks the run */ } });
        }
        const status = response.statusCode ?? 502;
        if (status >= 400) {
          const path = new URL(req.url ?? '', 'http://127.0.0.1').pathname;
          const chunks: Buffer[] = []; let size = 0;
          response.on('data', (chunk: Buffer) => { if (size < 65536) { chunks.push(chunk); size += chunk.length; } });
          response.on('end', () => console.log(upstreamErrorLine(status, path, Buffer.concat(chunks).toString('utf8').slice(0, 65536))));
        }
        response.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
      upstream.on('error', error => { console.log(`Upstream unavailable: ${logText(error.message)}`); if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream unavailable' } })); });
      upstream.end(body);
    });
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server)); });
}

/* c8 ignore start -- process entry point, exercised by scripts/test-claude-run.sh */
async function main() {
  const options = proxyOptions(process.env), portFile = process.env.HARNESS_PROXY_PORT_FILE ?? '';
  delete process.env.HARNESS_ANTHROPIC_API_KEY;
  if (!portFile) throw new Error('Proxy port file missing');
  const address = (await startProxy(options)).address();
  if (!address || typeof address === 'string') throw new Error('Proxy address unavailable');
  writeFileSync(portFile, `${address.port}\n`, { flag: 'wx', mode: 0o644 });
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(() => { console.error('Proxy failed to start'); process.exitCode = 1; });
/* c8 ignore stop */
