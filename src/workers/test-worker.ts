import { createHash } from 'node:crypto';
import type { GitHubPort } from '../github/port.js';
import type { Config } from '../config/index.js';
import { decodeEvent } from '../state/events.js';
import { workerInputSchema, workerResultSchema, type WorkerInput, type WorkerResult } from './contract.js';
import { actionId, taskVersion } from '../state/identity.js';
import { currentAutomaticBlock } from '../state/blocks.js';
import { permission, policyVersion } from '../policies/engine.js';
import type { Action } from '../types.js';

export function testOperation(value: unknown): WorkerResult {
  const input: WorkerInput = workerInputSchema.parse(value);
  const base = { contractVersion: '1.0' as const, executionId: input.executionId, issueNumber: input.issueNumber,
    artifacts: [] as string[], proposedActions: [], error: null };
  if (input.operation === 'fail') return workerResultSchema.parse({ ...base, status: 'failed', summary: 'Configured deterministic failure', error: 'Test operation failed intentionally' });
  if (input.operation === 'blocked') return workerResultSchema.parse({ ...base, status: 'blocked', summary: 'Configured deterministic block', error: 'Test operation requires external input' });
  const digest = createHash('sha256').update(input.description).digest('hex');
  return workerResultSchema.parse({ ...base, status: 'success', summary: `Validated task and calculated SHA-256: ${digest}`, artifacts: [`urn:sha256:${digest}`] });
}
export async function runTestWorker(github: GitHubPort, config: Config, issueNumber: number, id: string, correlationId: string): Promise<WorkerResult> {
  if (!config.harness.enabled || !config.workers.test.enabled || config.execution.dryRun || config.autonomy.profile === 'advisory') throw new Error('Worker execution disabled by configuration');
  const issue = await github.getIssue(issueNumber);
  const comments = await github.comments(issueNumber);
  const events = comments.flatMap(c => { const e = decodeEvent(c, config.manager.trustedActors); return e ? [e] : []; });
  const previous = events.find(e => e.data.type === 'result' && e.data.result.executionId === id);
  if (previous?.data.type === 'result') return previous.data.result;
  const event = events.find(e => e.data.type === 'intent' && e.data.input.executionId === id);
  if (event?.data.type !== 'intent') throw new Error('No trusted manager intent for this execution');
  const input = workerInputSchema.parse(event.data.input);
  if (input.repository.toLowerCase() !== github.repository.toLowerCase() || input.issueNumber !== issueNumber) throw new Error('Worker repository/issue mismatch');
  const original: Action = { kind: event.data.attempt === 0 ? 'start_worker' : 'retry_worker', issueNumber,
    taskVersion: input.taskVersion, attempt: event.data.attempt, status: null, priority: null, followup: null, reason: 'Revalidate original delegation' };
  let approved = false;
  for (const c of comments) {
    const command = c.body.trim().match(/^\/harness (approve|revoke) ([a-f0-9]{64})$/);
    if (command?.[2] === event.data.actionId && await github.canApprove(c.author)) approved = command[1] === 'approve';
  }
  const rule = permission(config, original.kind);
  const policyChanged = actionId(original, policyVersion(config)) !== event.data.actionId || rule === 'deny' || (rule === 'approval' && !approved);
  const explicitlyBlocked = issue.labels.includes('harness:blocked') && !currentAutomaticBlock(issue, events, config.manager.trustedActors);
  const stale = policyChanged || explicitlyBlocked || issue.state !== 'open' || !issue.labels.includes('harness:managed') || taskVersion(issue) !== input.taskVersion;
  const result = stale ? workerResultSchema.parse({ contractVersion: '1.0', executionId: id, issueNumber, status: 'cancelled',
    summary: 'Task, policy or approval changed after delegation', artifacts: [], error: null, proposedActions: [] }) : testOperation(input);
  if (Buffer.byteLength(JSON.stringify(result)) > input.limits.maxOutputBytes) throw new Error('Worker output exceeds contract resource limit');
  // This is the only worker mutation. Lifecycle remains exclusively manager-owned.
  await github.writeEvent(issueNumber, { version: 1, key: `result:${id}`, at: new Date().toISOString(), correlationId, data: { type: 'result', result } });
  return result;
}
