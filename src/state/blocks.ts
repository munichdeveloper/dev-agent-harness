import type { Issue } from '../types.js';
import type { HarnessEvent } from './events.js';

export const lastBlockLabelEventId = (issue: Issue): number => Math.max(0, ...(issue.blockedLabelEvents ?? []).map(e => e.id));

export function currentAutomaticBlock(issue: Issue, events: HarnessEvent[], trustedActors: string[]) {
  if (!issue.labels.includes('harness:blocked')) return;
  const changes = [...(issue.blockedLabelEvents ?? [])].sort((a, b) => a.id - b.id);
  const current = changes.at(-1);
  if (!current || current.event !== 'labeled' || !trustedActors.includes(current.actor)) return;
  // Only the first label change after an intent can belong to that intent.
  // A later remove/reapply (even by a trusted actor) cannot inherit an old origin.
  for (const event of [...events].reverse()) {
    if (event.data.type !== 'block_intent') continue;
    const floor = event.data.afterLabelEventId;
    const applied = changes.find(change => change.id > floor);
    if (applied?.id === current.id) return event.data;
  }
}
