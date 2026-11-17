// Credential proxy for one Claude run. It runs as the runner account, holds the Anthropic key and listens on
// 127.0.0.1 only; the worker account gets the proxy address and a placeholder key, so the key is never readable by
// the agent or its commands. Only model requests pass: no other endpoint, and no server-side tool (web search, web
// fetch, code execution) or remote MCP server, because those would reach the network on the agent's behalf.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { writeFileSync } from 'node:fs';

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

function main() {
  const key = process.env.HARNESS_ANTHROPIC_API_KEY ?? '', portFile = process.env.HARNESS_PROXY_PORT_FILE ?? '';
  if (!/^[\x21-\x7e]{20,300}$/.test(key) || !portFile) throw new Error('Proxy configuration rejected');
  delete process.env.HARNESS_ANTHROPIC_API_KEY;
  // Tests only: a stand-in API on this host's loopback. The Action never sets it.
  const local = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(process.env.HARNESS_PROXY_UPSTREAM ?? '');
  if (process.env.HARNESS_PROXY_UPSTREAM && !local) throw new Error('Proxy upstream rejected');
  const send = local ? httpRequest : httpsRequest, upstreamHost = local ? '127.0.0.1' : 'api.anthropic.com', upstreamPort = local ? Number(local[1]) : 443;
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
      const upstream = send({ host: upstreamHost, port: upstreamPort, method: 'POST', path: req.url,
        headers: forwardHeaders(req.headers, key, body.length), timeout: 600000 }, response => {
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding'].includes(name)) headers[name] = value;
        }
        res.writeHead(response.statusCode ?? 502, headers);
        response.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream unavailable' } })); });
      upstream.end(body);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Proxy address unavailable');
    writeFileSync(portFile, `${address.port}\n`, { flag: 'wx', mode: 0o644 });
  });
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
