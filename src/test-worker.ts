import { createHash } from 'node:crypto';
import type { RunRequest, WorkerOutput } from './contract.js';

export async function testWorker(request: RunRequest, context: { signal: AbortSignal }): Promise<WorkerOutput> {
  context.signal.throwIfAborted();
  if (request.operation === 'fail') return { status: 'failed', summary: 'Configured deterministic failure', artifacts: [], error: 'Test operation failed intentionally' };
  if (request.operation === 'blocked') return { status: 'blocked', summary: 'Configured deterministic block', artifacts: [], error: 'Test operation requires external input' };
  const digest = createHash('sha256').update(request.task.description).digest('hex');
  return { status: 'success', summary: `Validated task and calculated SHA-256: ${digest}`, artifacts: [`urn:sha256:${digest}`], error: null };
}
