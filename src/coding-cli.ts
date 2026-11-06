import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { codingMessageSchema, codingPrompt, codingRequestSchema, collectCodingArtifact } from './coding.js';

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const directory = resolve(process.env.RUNNER_TEMP!, `harness-${process.env.HARNESS_EXECUTION_ID}`);
  if (command === 'prepare') {
    const request = codingRequestSchema.parse(JSON.parse(process.env.HARNESS_REQUEST ?? ''));
    if (request.executionId !== process.env.HARNESS_EXECUTION_ID) throw new Error('Execution mismatch');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'request.json'), JSON.stringify(request));
    await writeFile(resolve(directory, 'prompt.txt'), codingPrompt(request));
    await writeFile(resolve(directory, 'message.schema.json'), JSON.stringify(z.toJSONSchema(codingMessageSchema)));
    await appendFile(process.env.GITHUB_OUTPUT!, `directory=${directory}\nmodel=${request.model}\neffort=${request.effort}\ntimeout=${request.limits.timeoutMinutes}\n`);
  } else if (command === 'collect') {
    const request = JSON.parse(await readFile(resolve(directory, 'request.json'), 'utf8'));
    const message = JSON.parse(await readFile(resolve(directory, 'output/message.json'), 'utf8'));
    const result = await collectCodingArtifact(request, process.env.HARNESS_WORKSPACE!, message);
    await writeFile(resolve(directory, 'output/artifact.json'), JSON.stringify(result));
  } else throw new Error('Invalid coding command');
}
main().catch(() => { console.error('Coding request or artifact rejected'); process.exitCode = 1; });
