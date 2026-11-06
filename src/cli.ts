import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { execute } from './runtime.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    input: { type: 'string' }, output: { type: 'string' }, 'github-output': { type: 'boolean', default: false }
  } });
  if (positionals.length !== 1 || positionals[0] !== 'run') throw new Error('Expected run command');
  let source = '';
  if (values.input) source = await readFile(values.input, 'utf8');
  else {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      source += String(chunk);
      if (Buffer.byteLength(source) > 512000) throw new Error('Input too large');
    }
  }
  if (Buffer.byteLength(source) > 512000) throw new Error('Input too large');
  const result = await execute(JSON.parse(source));
  const json = JSON.stringify(result);
  if (values.output) await writeFile(values.output, json + '\n', { flag: 'wx' });
  else process.stdout.write(json + '\n');
  if (values['github-output']) {
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT unavailable');
    await appendFile(process.env.GITHUB_OUTPUT, `result=${json}\n`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('Harness rejected the request or could not execute it. No input or credentials are logged.');
  process.exitCode = 2;
});
