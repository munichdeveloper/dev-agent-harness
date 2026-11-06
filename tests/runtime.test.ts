import { describe, expect, it } from 'vitest';
import { execute, requestSchema, resultSchema, type RunRequest } from '../src/index.js';

export const request = (): RunRequest => ({ contractVersion: '2.0', executionId: 'a'.repeat(32), worker: 'test',
  task: { id: 'task-1', version: 'b'.repeat(64), description: 'abc', acceptanceCriteria: ['Digest returned'], contextReferences: [] },
  allowedActions: ['run_test_operation'], limits: { timeoutMs: 1000, maxOutputBytes: 16000 }, operation: 'sha256' });

describe('single-run runtime', () => {
  it('executes the real digest operation and returns only the supplied run identity', async () => {
    const result = await execute(request());
    expect(result.status).toBe('success'); expect(result.executionId).toBe('a'.repeat(32));
    expect(result.artifacts).toEqual(['urn:sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']);
    expect(resultSchema.safeParse(result).success).toBe(true);
  });
  it.each(['fail', 'blocked'] as const)('reports the configured %s operation without retrying', async operation => {
    expect((await execute({ ...request(), operation })).status).toBe(operation === 'fail' ? 'failed' : 'blocked');
  });
  it('rejects unknown contract versions, capabilities and orchestration fields', async () => {
    for (const value of [{ ...request(), contractVersion: '1.0' }, { ...request(), autonomy: 'autonomous' },
      { ...request(), allowedActions: ['start_worker'] }, { ...request(), repository: 'a/b' }]) {
      await expect(execute(value)).rejects.toThrow();
    }
  });
  it('does not execute a worker whose capability was not granted', async () => {
    let calls = 0;
    const result = await execute({ ...request(), allowedActions: [] }, { worker: async () => { calls++; throw new Error('must not run'); } });
    expect(result.status).toBe('failed'); expect(calls).toBe(0);
  });
  it('enforces a per-run deadline without retrying or leaking thrown errors', async () => {
    let calls = 0;
    const result = await execute({ ...request(), limits: { ...request().limits, timeoutMs: 5 } }, {
      worker: async (_request, { signal }) => { calls++; expect(signal).toBeDefined(); return new Promise(() => {}); }
    });
    expect(result.status).toBe('timed_out'); expect(calls).toBe(1);
  });
  it('honors caller cancellation before and during execution', async () => {
    expect((await execute(request(), { signal: AbortSignal.abort() })).status).toBe('cancelled');
    const controller = new AbortController();
    const pending = execute(request(), { signal: controller.signal, worker: async () => new Promise(() => {}) });
    controller.abort(); expect((await pending).status).toBe('cancelled');
  });
  it('sanitizes worker exceptions and rejects invalid output', async () => {
    const result = await execute(request(), { worker: async () => { throw new Error('private-token-value'); } });
    expect(JSON.stringify(result)).not.toContain('private-token-value'); expect(result.status).toBe('failed');
    expect((await execute(request(), { worker: async () => ({ status: 'success', summary: '', artifacts: [], error: null }) })).status).toBe('failed');
  });
  it('enforces output byte limits on valid worker results', async () => {
    const result = await execute({ ...request(), limits: { ...request().limits, maxOutputBytes: 1024 } }, {
      worker: async () => ({ status: 'success', summary: 'x'.repeat(1800), artifacts: [], error: null })
    });
    expect(result.status).toBe('failed'); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
  });
  it('keeps accepted request fields explicit', () => {
    expect(requestSchema.safeParse({ ...request(), limits: { timeoutMs: 0, maxOutputBytes: 16000 } }).success).toBe(false);
  });
});
