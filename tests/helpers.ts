import { configSchema, type Config } from '../src/config/index.js';
import type { GitHubPort } from '../src/github/port.js';
import type { Comment, Issue, Snapshot, WorkflowRun } from '../src/types.js';
import { encodeEvent, type HarnessEvent } from '../src/state/events.js';
export const clock = new Date('2026-11-06T10:00:00.000Z');
export const config = (profile: Config['autonomy']['profile'] = 'autonomous'): Config => configSchema.parse({ version: 1, harness: { scope: 'Test task coordination' }, autonomy: { profile } });
export const issue = (number = 1, labels = ['harness:managed', 'harness:ready']): Issue => ({ number, title: `Task ${number}`,
  body: 'Implement the feature.\n\n## Acceptance criteria\n- Deterministic observable result\n', state: 'open', labels, updatedAt: clock.toISOString() });
export class MemoryGitHub implements GitHubPort {
  readonly repository = 'owner/target';
  state: Snapshot = { issues: [], comments: new Map(), prs: [], runs: [], defaultBranch: 'main', dependencyStates: new Map() };
  mutations: string[] = [];
  failDispatchAfterStart = false;
  failReceipt = false;
  dispatches = 0;
  async readConfig(): Promise<string> { return ''; }
  async snapshot(): Promise<Snapshot> { return structuredClone(this.state); }
  async getIssue(number: number): Promise<Issue> { const value = this.state.issues.find(i => i.number === number); if (!value) throw new Error('404'); return structuredClone(value); }
  async comments(number: number): Promise<Comment[]> { return structuredClone(this.state.comments.get(number) ?? []); }
  async canApprove(login: string): Promise<boolean> { return login === 'maintainer'; }
  async writeEvent(number: number, event: HarnessEvent): Promise<void> {
    if (event.data.type === 'receipt' && this.failReceipt) throw new Error('simulated receipt failure');
    this.mutations.push(`event:${event.key}`);
    const rows = this.state.comments.get(number) ?? [];
    rows.push({ id: rows.length + 1, author: 'github-actions[bot]', body: encodeEvent(event), createdAt: clock.toISOString() });
    this.state.comments.set(number, rows);
  }
  async updateIssue(number: number, update: { labels?: string[]; state?: 'open' | 'closed' }): Promise<void> {
    this.mutations.push(`update:${number}`); Object.assign(this.state.issues.find(i => i.number === number)!, update);
  }
  async createIssue(title: string, body: string, labels: string[]): Promise<Issue> {
    const next = { ...issue(this.state.issues.length + 1, labels), title, body };
    this.state.issues.push(next); this.mutations.push(`create:${next.number}`); return structuredClone(next);
  }
  async bootstrap(): Promise<string[]> { return []; }
  async dispatch(_workflow: string, _ref: string, id: string): Promise<void> {
    this.dispatches++;
    this.state.runs.push({ id: this.dispatches, title: `Harness worker ${id}`, status: 'in_progress', conclusion: null, createdAt: clock.toISOString(), url: `https://github.com/owner/target/actions/runs/${this.dispatches}` });
    if (this.failDispatchAfterStart) throw new Error('Ambiguous network failure after dispatch');
  }
  async runs(): Promise<WorkflowRun[]> { return structuredClone(this.state.runs); }
  async cancelRun(id: number): Promise<void> { this.mutations.push(`cancel:${id}`); const run = this.state.runs.find(r => r.id === id)!; run.status = 'completed'; run.conclusion = 'cancelled'; }
  approve(number: number, id: string, author = 'maintainer'): void {
    const rows = this.state.comments.get(number) ?? [];
    rows.push({ id: rows.length + 1, body: `/harness approve ${id}`, author, createdAt: clock.toISOString() }); this.state.comments.set(number, rows);
  }
}
