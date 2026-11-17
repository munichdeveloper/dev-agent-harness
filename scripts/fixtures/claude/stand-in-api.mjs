// A stand-in for the Messages API, for scripts/test-claude-run.sh: it records each request, has Claude Code run two
// commands (write a file, try the network), then returns the structured result. No real model is involved.
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import process from 'node:process';
const [log, portFile] = process.argv.slice(2);
const steps = [
  { name: 'Bash', input: { command: 'echo claude > claude.txt', description: 'Write a file' } },
  { name: 'Bash', input: { command: 'if timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443"; then echo NETWORK-OPEN > network.txt; else echo closed > network.txt; fi', description: 'Probe the network' } },
  { name: 'StructuredOutput', input: { status: 'success', summary: 'Stand-in run finished' } }
];
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    appendFileSync(log, JSON.stringify({ path: req.url, key: req.headers['x-api-key'], authorization: req.headers.authorization ?? null,
      tools: (body.tools ?? []).map(t => t.name) }) + '\n');
    const done = JSON.stringify(body.messages ?? []).split('"tool_result"').length - 1;
    const step = steps[done], content = step ? [{ type: 'tool_use', id: `toolu_${done}`, name: step.name, input: step.input }] : [{ type: 'text', text: 'Finished' }];
    const message = { id: `msg_${done}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null } });
    content.forEach((block, index) => {
      if (block.type === 'text') { event('content_block_start', { index, content_block: { type: 'text', text: '' } }); event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } }); }
      else { event('content_block_start', { index, content_block: { ...block, input: {} } }); event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }); }
      event('content_block_stop', { index });
    });
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
    event('message_stop', {}); res.end();
  });
});
server.listen(0, '127.0.0.1', () => appendFileSync(portFile, `${server.address().port}\n`));
