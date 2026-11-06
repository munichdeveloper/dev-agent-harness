import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
for (const path of [...(await readdir('.github/workflows')).map(f => `.github/workflows/${f}`), 'templates/harness-manager.yml']) {
  const doc = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true });
  assert.equal(doc.errors.length, 0, `${path}: invalid YAML`);
  const workflow = doc.toJS();
  assert(workflow.on && workflow.jobs && workflow.permissions, `${path}: missing explicit permissions/events/jobs`);
  assert(!workflow.on.pull_request_target, `${path}: privileged pull_request_target is forbidden`);
  if (path.includes('templates/')) {
    assert(workflow.on.schedule && workflow.on.workflow_dispatch && workflow.concurrency, 'Caller must serialize managers and expose both triggers');
  }
  for (const job of Object.values(workflow.jobs) as { permissions?: unknown; uses?: string; steps?: { uses?: string; with?: Record<string, unknown> }[] }[]) {
    assert(job.permissions, `${path}: job permissions must be explicit`);
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(step.with?.repository, 'munichdeveloper/dev-agent-harness', 'Never checkout untrusted target code');
        assert.equal(step.with?.['persist-credentials'], false);
      }
    }
  }
  console.log(`Validated ${path}`);
}
