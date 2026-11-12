// Stand-in Responses API for the loopback test. Codex must reach it; the one command it requests must not.
import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

let verdict = 'no command result';
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; }).on('end', () => {
    const port = server.address().port;
    const cmd = `node ${fileURLToPath(new URL('loopback-probe.mjs', import.meta.url))} '${readlinkSync('/proc/self/ns/net')}' ${port} && echo isolated-$((${port}+1))`;
    const finished = body.includes('function_call_output');
    if (finished) verdict = body.includes(`isolated-${port + 1}`) ? 'isolated' : 'command could leave its loopback';
    const item = finished ? { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'done' }] }
      : body.includes('"exec_command"') ? { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: JSON.stringify({ cmd }) }
        : { type: 'function_call', call_id: 'c1', name: 'shell_command', arguments: JSON.stringify({ command: cmd }) };
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(event({ type: 'response.created', response: { id: 'r1' } }) +
      event({ type: 'response.output_item.done', item }) + event({ type: 'response.completed', response: { id: 'r1',
        usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } }));
  });
}).listen(0, '127.0.0.1', () => {
  const provider = key => `model_providers.mock.${key}`;
  spawn('sudo', ['-u', 'codex-worker', 'env', 'HOME=/home/codex-worker', 'CODEX_HOME=/home/codex-worker/.codex', `PATH=${process.env.PATH}`,
    'codex', 'exec', '--skip-git-repo-check', '--cd', process.env.TARGET, '--model', 'gpt-6.1-sol', '-c', 'default_permissions="harness-loopback"',
    '-c', 'model_provider="mock"', '-c', `${provider('name')}="mock"`, '-c', `${provider('wire_api')}="responses"`,
    '-c', `${provider('base_url')}="http://127.0.0.1:${server.address().port}/v1"`, 'probe'], { stdio: ['ignore', 'inherit', 'inherit'] })
    .on('exit', status => { process.stdout.write(`codex exec: ${status}, ${verdict}\n`); process.exit(status === 0 && verdict === 'isolated' ? 0 : 1); });
});
