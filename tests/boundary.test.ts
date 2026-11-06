import { readdir, readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('keeps orchestration, repository credentials and factory policy out of production runtime code', async () => {
  const files = await readdir('src', { recursive: true });
  for (const path of files.filter(f => f.endsWith('.ts'))) {
    const source = await readFile(`src/${path}`, 'utf8');
    expect(source, path).not.toMatch(/@octokit|GITHUB_TOKEN|OPENAI_API_KEY|workflow_dispatch|autonomy|create_followup|harness:managed/);
  }
});
