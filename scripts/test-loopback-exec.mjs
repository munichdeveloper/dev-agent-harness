// Stand-in Responses API for the credential-free tests: a real codex exec runs one command it requests.
// With the loopback profile Codex must reach this server and the command must not; a refused registry lookup must
// not abort the command, and with BROWSER_TEST_DIR a Playwright test against a local server must pass.
// Otherwise the command only has to run.
import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const profile = process.env.HARNESS_PROFILE ?? 'harness-loopback';
const home = process.env.CODEX_HOME ?? '/home/codex-worker/.codex';
const browser = process.env.BROWSER_TEST_DIR;
// A control run names the failure it must produce instead.
const expected = process.env.EXPECTED_VERDICT ?? 'passed';
let verdict = 'Codex returned no tool result';
let output = '';
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
// The advertised tools depend on the model: top level or in an input item, possibly nested in namespaces.
const advertised = (tools, namespace) => (tools ?? []).flatMap(tool => tool.type === 'namespace'
  ? advertised(tool.tools, tool.name) : [{ type: tool.type, name: tool.name, namespace }]);
const call = (tools, cmd) => {
  const find = (type, name) => tools.find(tool => tool.type === type && tool.name === name);
  const item = (tool, fields) => ({ call_id: 'c1', name: tool.name, ...(tool.namespace && { namespace: tool.namespace }), ...fields });
  const direct = find('function', 'exec_command') ?? find('function', 'shell_command');
  if (direct) return item(direct, { type: 'function_call', arguments: JSON.stringify(direct.name === 'exec_command'
    ? { cmd, yield_time_ms: 120000 } : { command: cmd, timeout_ms: 120000 }) });
  // Code mode: one JavaScript tool whose nested exec_command runs the shell command.
  const code = find('custom', 'exec');
  if (code) return item(code, { type: 'custom_tool_call', input: `// @exec: {"yield_time_ms": 120000}\n` +
    `text(await tools.exec_command({ cmd: ${JSON.stringify(cmd)}, yield_time_ms: 120000 }));` });
  verdict = `no known command tool advertised: ${tools.map(tool => tool.name).join(', ')}`;
  return { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: verdict }] };
};
// Each step prints a marker the shell computes, so a marker appears in a later request only if that step really ran.
const steps = port => {
  const probe = fileURLToPath(new URL('loopback-probe.mjs', import.meta.url));
  const marker = (index, name) => ({ name, text: `${name}-${port + index}`, echo: `echo ${name}-$((${port}+${index}))` });
  const list = [[marker(1, 'started'), 'true', 'the command did not run']];
  if (profile !== 'harness-loopback') return list;
  list.push([marker(2, 'isolated'), `node ${probe} '${readlinkSync('/proc/self/ns/net')}' ${port}`, 'the command ran and was not isolated']);
  // Incidental lookups like npm's update check or Next.js telemetry: refused, and the command must go on.
  list.push([marker(3, 'continued'), "node -e \"fetch('https://registry.npmjs.org/-/package/next/dist-tags').then(() => process.exit(1), () => {})\"" +
    ' && ! curl -fsS -m 10 -o /dev/null https://registry.npmjs.org/', 'a registry lookup was not refused']);
  if (browser) list.push([marker(4, 'browser'), `(cd ${browser} && node_modules/.bin/playwright test)`, 'the browser test against a local server failed']);
  return list;
};
const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; }).on('end', () => {
    const list = steps(server.address().port);
    const cmd = list.map(([marker, step]) => `${step} && ${marker.echo}`).join(' && ');
    const parsed = JSON.parse(body);
    const results = (parsed.input ?? []).filter(entry => /_call_output$/.test(entry.type ?? ''));
    if (results.length > 0) {
      output = JSON.stringify(results.map(entry => entry.output));
      // Codex replaces the output of a command it aborts for a blocked network request with that message.
      verdict = /Network access to [^ ]+ was blocked/.test(output) ? 'a blocked network request aborted the command'
        : list.find(([marker]) => !output.includes(marker.text))?.[2] ?? 'passed';
    }
    const item = results.length > 0 ? { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'done' }] }
      : call([...advertised(parsed.tools), ...(parsed.input ?? []).flatMap(entry => advertised(entry.tools))], cmd);
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(event({ type: 'response.created', response: { id: 'r1' } }) +
      event({ type: 'response.output_item.done', item }) + event({ type: 'response.completed', response: { id: 'r1',
        usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } }));
  });
}).listen(0, '127.0.0.1', () => {
  const provider = key => `model_providers.mock.${key}`;
  spawn('sudo', ['-u', 'codex-worker', 'env', 'HOME=/home/codex-worker', `CODEX_HOME=${home}`, `PATH=${process.env.PATH}`,
    'codex', 'exec', '--skip-git-repo-check', '--cd', process.env.TARGET, '--model', process.env.MODEL ?? 'gpt-6.1-sol', '-c', `default_permissions="${profile}"`,
    '-c', 'model_provider="mock"', '-c', `${provider('name')}="mock"`, '-c', `${provider('wire_api')}="responses"`,
    '-c', `${provider('base_url')}="http://127.0.0.1:${server.address().port}/v1"`, 'probe'], { stdio: ['ignore', 'inherit', 'inherit'] })
    .on('exit', status => {
      if (verdict !== expected) process.stdout.write(`command output: ${output}\n`);
      process.stdout.write(`codex exec: ${status}, ${verdict}\n`);
      process.exit(status === 0 && verdict === expected ? 0 : 1);
    });
});
