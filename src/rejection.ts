import { z } from 'zod';
import { logText } from './claude-proxy.js';

/**
 * Why `coding-cli` refused a request or an artifact, as one bounded log line. Schema errors name the failing field
 * (e.g. that the agent's structured output is missing), never the values, which may come from the worker.
 */
export function rejectionReason(error: unknown): string {
  if (error instanceof z.ZodError) {
    return logText(error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  }
  if (error instanceof SyntaxError) return 'invalid JSON';
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'file missing';
  if (error instanceof Error) return logText(error.message);
  return 'unknown error';
}
