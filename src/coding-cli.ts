import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { browserCacheDirectory, codingMessageSchema, codingPrompt, codingRequestSchema, collectCodingArtifact } from './coding.js';

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const directory = resolve(process.env.RUNNER_TEMP!, `harness-${process.env.HARNESS_EXECUTION_ID}`);
  if (command === 'prepare') {
    const request = codingRequestSchema.parse(JSON.parse(process.env.HARNESS_REQUEST ?? ''));
    if (request.executionId !== process.env.HARNESS_EXECUTION_ID) throw new Error('Execution mismatch');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'request.json'), JSON.stringify(request));
    const loopback = z.enum(['true', 'false']).parse(process.env.HARNESS_LOOPBACK || 'false') === 'true';
    await writeFile(resolve(directory, 'prompt.txt'), codingPrompt(request, loopback));
    await writeFile(resolve(directory, 'message.schema.json'), JSON.stringify(z.toJSONSchema(codingMessageSchema)));
    await appendFile(process.env.GITHUB_OUTPUT!, `directory=${directory}\nmodel=${request.model}\neffort=${request.effort}\ntimeout=${request.limits.timeoutMinutes}\nprofile=${loopback ? 'harness-loopback' : ':workspace'}\n`);
  } else if (command === 'collect') {
    const request = JSON.parse(await readFile(resolve(directory, 'request.json'), 'utf8'));
    if ((await stat(resolve(directory, 'output/message.json'))).size > 16000) throw new Error('Message too large');
    const message = JSON.parse(await readFile(resolve(directory, 'output/message.json'), 'utf8'));
    const result = await collectCodingArtifact(request, process.env.HARNESS_WORKSPACE!, message);
    await writeFile(resolve(directory, 'output/artifact.json'), JSON.stringify(result));
  } else if (command === 'browser-cache') {
    console.log(await browserCacheDirectory(process.env.HARNESS_BROWSER_CACHE ?? '', [process.env.RUNNER_TEMP, process.env.HOME]));
  } else throw new Error('Invalid coding command');
}
main().catch(() => { console.error('Coding request or artifact rejected'); process.exitCode = 1; });
