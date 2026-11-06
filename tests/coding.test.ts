import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { codingPrompt, codingRequestSchema, collectCodingArtifact, validChangePath } from '../src/coding.js';

const request = { contractVersion: '3.0', executionId: 'a'.repeat(32), worker: 'codex',
  task: { id: 'opaque:task-1', version: 'b'.repeat(64), description: 'Fix the bug', acceptanceCriteria: ['Tests pass'], contextReferences: [] },
  allowedActions: ['edit_workspace', 'run_commands'], baseSha: 'c'.repeat(40), model: 'gpt-6.1-sol', effort: 'high',
  limits: { timeoutMinutes: 30, maxFiles: 100, maxPatchBytes: 5000000 } };
const message = { status: 'success', summary: 'Implemented and tested' };
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function repository() {
  const dir = await mkdtemp(join(tmpdir(), 'coding-harness-')); directories.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(dir, 'original.txt'), 'before'); await writeFile(join(dir, 'delete.txt'), 'remove');
  git('add', '.'); git('commit', '-m', 'base');
  return { dir, git, input: { ...request, baseSha: git('rev-parse', 'HEAD') } };
}
it('requires a bounded single-run capability envelope and builds a data-only prompt', () => {
  expect(codingRequestSchema.safeParse(request).success).toBe(true);
  expect(codingRequestSchema.safeParse({ ...request, allowedActions: [] }).success).toBe(false);
  expect(codingRequestSchema.safeParse({ ...request, limits: { ...request.limits, timeoutMinutes: 31 } }).success).toBe(false);
  expect(codingPrompt(request)).toContain('Read and follow AGENTS.md');
  expect(codingPrompt(request)).toContain(JSON.stringify(request.task, null, 2));
});
it.each(['../escape', '/absolute', 'a//b', 'a\\b', 'C:/escape', 'a/./b', 'a/../b', 'a.'])('rejects unsafe path %s', path => {
  expect(validChangePath(path)).toBe(false);
});
it('collects tracked edits, deletions and new files including changes committed by the agent', async () => {
  const { dir, git, input } = await repository();
  await writeFile(join(dir, 'original.txt'), 'after'); git('add', '.'); git('commit', '-m', 'agent');
  await rm(join(dir, 'delete.txt')); await mkdir(join(dir, 'docs')); await writeFile(join(dir, 'docs/new.txt'), 'new');
  const artifact = await collectCodingArtifact(input, dir, message);
  expect(artifact.result.taskId).toBe(request.task.id);
  expect(artifact.changes.map(c => [c.path, c.content && Buffer.from(c.content, 'base64').toString()]))
    .toEqual([['delete.txt', null], ['docs/new.txt', 'new'], ['original.txt', 'after']]);
});
it('refuses too many files and oversized content', async () => {
  const { dir, input } = await repository();
  await writeFile(join(dir, 'large.txt'), 'x'.repeat(2000));
  await expect(collectCodingArtifact({ ...input, limits: { ...input.limits, maxPatchBytes: 1024 } }, dir, message)).rejects.toThrow('oversized');
  await writeFile(join(dir, 'extra.txt'), 'extra');
  await expect(collectCodingArtifact({ ...input, limits: { ...input.limits, maxFiles: 1 } }, dir, message)).rejects.toThrow('Too many');
});
it.runIf(process.platform !== 'win32')('refuses symlinks to files inside or outside the workspace', async () => {
  const { dir, input } = await repository();
  await symlink(join(dir, 'original.txt'), join(dir, 'link.txt'));
  await expect(collectCodingArtifact(input, dir, message)).rejects.toThrow('Symlink');
});
