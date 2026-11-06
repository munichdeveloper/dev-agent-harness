import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
for (const name of await readdir('.github/workflows')) {
  const doc = parseDocument(await readFile(`.github/workflows/${name}`, 'utf8'), { uniqueKeys: true });
  assert.equal(doc.errors.length, 0); const workflow = doc.toJS();
  assert(workflow.permissions && workflow.jobs && workflow.on);
  assert(!workflow.on.schedule && !workflow.on.workflow_dispatch && !workflow.on.pull_request_target, 'Runtime does not orchestrate or schedule runs');
  for (const job of Object.values(workflow.jobs) as { permissions: Record<string, string> }[]) {
    assert.deepEqual(job.permissions, { contents: 'read' });
  }
  console.log(`Validated ${name}`);
}
