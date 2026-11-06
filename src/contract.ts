import { z } from 'zod';

export const requestSchema = z.strictObject({
  contractVersion: z.literal('2.0'), executionId: z.string().regex(/^[a-f0-9]{32}$/), worker: z.literal('test'),
  task: z.strictObject({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:/#._-]{0,199}$/), version: z.string().regex(/^[a-f0-9]{64}$/),
    description: z.string().min(1).max(20000), acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(20),
    contextReferences: z.array(z.string().max(1000)).max(30) }),
  allowedActions: z.array(z.literal('run_test_operation')).max(1),
  limits: z.strictObject({ timeoutMs: z.number().int().min(1).max(1800000), maxOutputBytes: z.number().int().min(1024).max(16000) }),
  operation: z.enum(['sha256', 'fail', 'blocked'])
});
export const outputSchema = z.strictObject({
  status: z.enum(['success', 'failed', 'blocked', 'needs_approval', 'cancelled', 'timed_out']),
  summary: z.string().min(1).max(2000), artifacts: z.array(z.string().max(2000)).max(20), error: z.string().max(2000).nullable()
});
export const resultSchema = outputSchema.extend({
  contractVersion: z.literal('2.0'), executionId: z.string().regex(/^[a-f0-9]{32}$/),
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:/#._-]{0,199}$/), taskVersion: z.string().regex(/^[a-f0-9]{64}$/)
});
export type RunRequest = z.infer<typeof requestSchema>;
export type WorkerOutput = z.infer<typeof outputSchema>;
export type RunResult = z.infer<typeof resultSchema>;
