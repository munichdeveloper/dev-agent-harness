import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function run(input: string | undefined, args = ['run']): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], { windowsHide: true });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const request = { contractVersion: '2.0', executionId: 'a'.repeat(32), worker: 'test', task: { id: 'fixture', version: 'b'.repeat(64),
  description: 'Grüße 👋', acceptanceCriteria: ['Digest returned'], contextReferences: [] }, allowedActions: ['run_test_operation'],
  limits: { timeoutMs: 1000, maxOutputBytes: 16000 }, operation: 'sha256' };
it('returns one machine-readable run result through the standalone CLI', async () => {
  const result = await run(JSON.stringify(request)); expect(result.code).toBe(0);
  expect(JSON.parse(result.out).status).toBe('success'); expect(result.err).toBe('');
});
it.each(['invalid-json-secret', JSON.stringify({ ...request, contractVersion: '1.0' }), 'x'.repeat(512001)])('rejects invalid input without echoing it', async input => {
  const result = await run(input); expect(result.code).toBe(2); expect(result.out).toBe(''); expect(result.err).not.toContain(input.slice(0, 50));
});
it('rejects oversized file input without reading the whole file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dev-agent-harness-'));
  const inputPath = join(directory, 'input.json');
  try {
    await writeFile(inputPath, 'x'.repeat(512001));
    const result = await run(undefined, ['run', '--input', inputPath]);
    expect(result.code).toBe(2); expect(result.out).toBe('');
    expect(result.err).not.toContain('x'.repeat(50));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('rejects removed orchestration commands', async () => { expect((await run('{}', ['manager'])).code).toBe(2); });
