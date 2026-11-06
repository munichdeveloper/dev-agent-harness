import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { directory: { type: 'string' }, ref: { type: 'string' } } });
if (!values.directory || !values.ref || !/^[a-f0-9]{40}$/.test(values.ref)) throw new Error('Usage: npx tsx scripts/install.ts --directory TARGET --ref 40_CHAR_COMMIT_SHA');
for (const [source, destination] of [['harness.yml', '.github/harness.yml'], ['harness-manager.yml', '.github/workflows/harness-manager.yml']]) {
  const content = (await readFile(new URL(`../templates/${source}`, import.meta.url), 'utf8')).replaceAll('HARNESS_COMMIT_SHA', values.ref);
  const target = resolve(values.directory, destination!);
  await mkdir(dirname(target), { recursive: true });
  try { await writeFile(target, content, { flag: 'wx' }); console.log(`Created ${destination}`); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; console.log(`Preserved existing ${destination}`); }
}
