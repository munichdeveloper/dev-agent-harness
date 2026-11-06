import { outputSchema, requestSchema, resultSchema, type RunRequest, type RunResult, type WorkerOutput } from './contract.js';
import { testWorker } from './test-worker.js';

export type WorkerHandler = (request: RunRequest, context: { signal: AbortSignal }) => Promise<WorkerOutput>;
export async function execute(value: unknown, options: { worker?: WorkerHandler; signal?: AbortSignal } = {}): Promise<RunResult> {
  const request = requestSchema.parse(value);
  const identity = { contractVersion: '2.0' as const, executionId: request.executionId, taskId: request.task.id, taskVersion: request.task.version };
  const failure = (status: RunResult['status'], summary: string): RunResult => resultSchema.parse({ ...identity, status, summary, artifacts: [], error: summary });
  if (!request.allowedActions.includes('run_test_operation')) return failure('failed', 'Capability run_test_operation was not granted');
  if (options.signal?.aborted) return failure('cancelled', 'Execution cancelled by caller');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.limits.timeoutMs);
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Execution aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const output = outputSchema.parse(await Promise.race([(options.worker ?? testWorker)(request, { signal }), aborted]));
    const result = resultSchema.parse({ ...identity, ...output });
    if (Buffer.byteLength(JSON.stringify(result)) > request.limits.maxOutputBytes) return failure('failed', 'Worker output exceeded maxOutputBytes');
    return result;
  } catch {
    return failure(timedOut ? 'timed_out' : signal.aborted ? 'cancelled' : 'failed',
      timedOut ? 'Execution exceeded timeoutMs' : signal.aborted ? 'Execution cancelled by caller' : 'Worker execution failed or returned an invalid result');
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
