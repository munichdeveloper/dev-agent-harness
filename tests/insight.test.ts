import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { diffStat } from '../src/coding.js';
import { boundedDiff, claudeTrace, commandWord, insightSchema, maxDiffFiles, maxTraceEntries, newFileLines, numstat, toolPath } from '../src/insight.js';

const assistant = (usage: object, ...blocks: object[]) => JSON.stringify({ type: 'assistant', message: { content: blocks, usage } });
const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });

it('traces tools in order without inputs or outputs', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    assistant({ input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 17000, output_tokens: 40 },
      toolUse('a', 'Read', { file_path: '/work/repo/src/app.ts' }), toolUse('b', 'Grep', { pattern: 'secret value', path: 'src' })),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'file text' },
      { type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'boom' }] } }),
    assistant({ input_tokens: 2, cache_read_input_tokens: 17000, output_tokens: 300 },
      toolUse('c', 'Bash', { command: 'CI=1 npm test -- --token=abc' }), toolUse('d', 'Edit', { file_path: '/etc/passwd' }),
      toolUse('e', 'Bash', { command: 'cd web && npx vitest run' }), { type: 'text', text: 'done' }),
    'not json'
  ];
  const trace = claudeTrace(lines, '/work/repo');
  expect(trace).toEqual({
    trace: [
      { turn: 1, tool: 'Read', target: 'src/app.ts', error: false },
      { turn: 1, tool: 'Grep', target: 'src', error: true },
      { turn: 2, tool: 'Bash', target: 'npm', error: false },
      { turn: 2, tool: 'Edit', target: null, error: false },
      { turn: 2, tool: 'Bash', target: 'npx', error: false }
    ],
    traceTruncated: false, firstRequestInputTokens: 17005, outputTokensPerTurn: [40, 300]
  });
  expect(JSON.stringify(trace)).not.toMatch(/secret|abc|file text|boom/);
});

it('caps the trace', () => {
  const blocks = Array.from({ length: maxTraceEntries + 5 }, (_, i) => toolUse(`t${i}`, 'Read', { file_path: 'a.ts' }));
  const trace = claudeTrace([assistant({ output_tokens: 1 }, ...blocks)], '/w');
  expect(trace.trace).toHaveLength(maxTraceEntries);
  expect(trace.traceTruncated).toBe(true);
});

it('keeps only plain workspace paths and command words', () => {
  expect(toolPath('/w/x/y.ts', '/w')).toBe('x/y.ts');
  expect(toolPath('/w', '/w')).toBe('.');
  expect(toolPath('../outside', '/w')).toBeNull();
  expect(toolPath('has space.ts', '/w')).toBeNull();
  expect(toolPath(42, '/w')).toBeNull();
  expect(commandWord('/usr/bin/git status')).toBe('git');
  expect(commandWord('A=1 B=2 node x.js')).toBe('node');
  expect(commandWord('$(curl x)')).toBeNull();
  expect(commandWord(undefined)).toBeNull();
});

it('reads numstat output and counts new files', () => {
  expect(numstat('3\t1\tsrc/a.ts\0-\t-\timg.png\0garbage\0')).toEqual([
    { path: 'src/a.ts', added: 3, removed: 1 }, { path: 'img.png', added: null, removed: null }]);
  expect(newFileLines(Buffer.from('a\nb\n'))).toBe(2);
  expect(newFileLines(Buffer.from('a\nb'))).toBe(2);
  expect(newFileLines(Buffer.from(''))).toBe(0);
  expect(newFileLines(Buffer.from([1, 0, 2]))).toBeNull();
  const many = Array.from({ length: maxDiffFiles + 1 }, (_, i) => ({ path: `f${String(i).padStart(4, '0')}`, added: 1, removed: 0 }));
  const bounded = boundedDiff(many);
  expect(bounded.diff).toHaveLength(maxDiffFiles);
  expect(bounded.diffTruncated).toBe(true);
  expect(insightSchema.safeParse({ trace: [], traceTruncated: false, firstRequestInputTokens: null, outputTokensPerTurn: [], ...bounded }).success).toBe(true);
});

it('measures the change against the base including untracked files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'diffstat-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  run('init', '-q'); run('config', 'user.email', 'x@example.com'); run('config', 'user.name', 'x');
  await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n'); run('add', '.'); run('commit', '-qm', 'base');
  const base = run('rev-parse', 'HEAD').trim();
  await writeFile(join(cwd, 'a.txt'), 'one\nthree\nfour\n');
  await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src/new.ts'), 'x\ny\nz');
  expect(await diffStat(base, cwd)).toEqual({ diff: [{ path: 'a.txt', added: 2, removed: 1 }, { path: 'src/new.ts', added: 3, removed: 0 }], diffTruncated: false });
});

it('adds the insight to the usage record of a Claude run', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'insight-cli-')), id = 'e'.repeat(32), directory = join(temp, `harness-${id}`);
  const request = { contractVersion: '3.0', executionId: id, worker: 'claude',
    task: { id: 'opaque:1', version: 'b'.repeat(64), description: 'x', acceptanceCriteria: ['y'], contextReferences: [] },
    allowedActions: ['edit_workspace', 'run_commands'], baseSha: 'c'.repeat(40), model: 'claude-sonnet-5-5', effort: 'medium',
    limits: { timeoutMinutes: 30, maxFiles: 100, maxPatchBytes: 5000000 } };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'request.json'), JSON.stringify(request));
  await writeFile(join(directory, 'claude-stream.jsonl'), [assistant({ input_tokens: 1, cache_creation_input_tokens: 9000, output_tokens: 7 },
    toolUse('a', 'Read', { file_path: '/ws/README.md' }))].join('\n'));
  await writeFile(join(directory, 'diffstat.json'), JSON.stringify({ diff: [{ path: 'README.md', added: 1, removed: 0 }], diffTruncated: false }));
  const env = { ...process.env, RUNNER_TEMP: temp, HARNESS_EXECUTION_ID: id, HARNESS_WORKSPACE: '/ws' };
  const log = execFileSync('node', ['dist/coding-cli.js', 'usage'], { env, encoding: 'utf8' });
  expect(log).toContain('trace=1 first_request_input=9001 diff_files=1');
  expect(JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8')).insight).toEqual({
    trace: [{ turn: 1, tool: 'Read', target: 'README.md', error: false }], traceTruncated: false,
    firstRequestInputTokens: 9001, outputTokensPerTurn: [7], diff: [{ path: 'README.md', added: 1, removed: 0 }], diffTruncated: false });
  // A malformed change size is dropped, the trace stays.
  await writeFile(join(directory, 'diffstat.json'), '{"diff":"nope"}');
  execFileSync('node', ['dist/coding-cli.js', 'usage'], { env });
  expect(JSON.parse(await readFile(join(directory, 'usage.json'), 'utf8')).insight).toMatchObject({ diff: null, trace: [{ tool: 'Read' }] });
});
