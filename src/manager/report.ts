import type { Action, Decision } from '../types.js';

export interface RunReport {
  correlationId: string; startedAt: string; durationMs: number; outcome: 'success' | 'partial' | 'disabled' | 'failed';
  tasks: number; decisions: { action: Action; decision: Decision; executed: boolean }[];
  errors: string[]; blockers: string[]; nextSteps: string[];
}
export function summary(report: RunReport): string {
  const safe = (s: string) => s.replace(/[<>|\r\n]/g, ' ').replace(/`/g, "'");
  return [`# Dev Agent Harness v0.1`, '', `Run: \`${report.correlationId}\``,
    `Started: ${report.startedAt} · Duration: ${report.durationMs}ms · Result: ${report.outcome}`,
    `Managed tasks: ${report.tasks}`, '', '| Issue | Action | Decision | Executed | Reason / approval ID |',
    '|---|---|---|---|---|',
    ...report.decisions.map(({ action, decision, executed }) => `| #${action.issueNumber} | ${action.kind}${action.status ? ` → ${action.status}` : ''} | ${decision.outcome} | ${executed} | ${safe(decision.reason)} — \`${decision.actionId}\` |`),
    '', '## Errors', ...report.errors.map(e => `- ${safe(e)}`), '', '## Blockers', ...report.blockers.map(e => `- ${safe(e)}`),
    '', '## Next steps', ...report.nextSteps.map(e => `- ${safe(e)}`), ''
  ].join('\n');
}
