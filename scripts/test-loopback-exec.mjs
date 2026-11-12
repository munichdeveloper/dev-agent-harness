// Stand-in Responses API for the credential-free tests: a real codex exec runs one command it requests.
// With the loopback profile Codex must reach this server and the command must not; otherwise the command only has to run.
import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const profile = process.env.HARNESS_PROFILE ?? 'harness-loopback';
const home = process.env.CODEX_HOME ?? '/home/codex-worker/.codex';
const expected = profile === 'harness-loopback' ? 'isolated' : 'ran';
let verdict = 'Codex returned no tool result';
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
// The advertised tools depend on the model: top level or in an input item, possibly nested in namespaces.
const advertised = (tools, namespace) => (tools ?? []).flatMap(tool => tool.type === 'namespace'
  ? advertised(tool.tools, tool.name) : [{ type: tool.type, name: tool.name, namespace }]);
const call = (tools, cmd) => {
  const find = (type, name) => tools.find(tool => tool.type === type && tool.name === name);
  const item = (tool, fields) => ({ call_id: 'c1', name: tool.name, ...(tool.namespace && { namespace: tool.namespace }), ...fields });
  const direct = find('function', 'exec_command') ?? find('function', 'shell_command');
  if (direct) return item(direct, { type: 'function_call', arguments: JSON.stringify(direct.name === 'exec_command' ? { cmd } : { command: cmd }) });
  // Code mode: one JavaScript tool whose nested exec_command runs the shell command.
  const code = find('custom', 'exec');
  if (code) return item(code, { type: 'custom_tool_call', input: `text(await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }));` });
  verdict = `no known command tool advertised: ${tools.map(tool => tool.name).join(', ')}`;
  return { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: verdict }] };
};
const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; }).on('end', () => {
    const port = server.address().port;
    const probe = fileURLToPath(new URL('loopback-probe.mjs', import.meta.url));
    // The shell computes both markers, so they appear in a later request only as output of a command that really ran.
    const cmd = `echo started-$((${port}+1))` + (expected === 'isolated' ? `; node ${probe} '${readlinkSync('/proc/self/ns/net')}' ${port} && echo isolated-$((${port}+2))` : '');
    const parsed = JSON.parse(body);
    const finished = /_call_output"/.test(body);
    if (finished) verdict = !body.includes(`started-${port + 1}`) ? 'the command did not run' : expected === 'ran' ? 'ran'
      : body.includes(`isolated-${port + 2}`) ? 'isolated' : 'the command ran and was not isolated';
    const item = finished ? { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'done' }] }
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
    .on('exit', status => { process.stdout.write(`codex exec: ${status}, ${verdict}\n`); process.exit(status === 0 && verdict === expected ? 0 : 1); });
});
