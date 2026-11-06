# Dev Agent Harness

GitHub-native task orchestration, **v0.1.0**. A stateless TypeScript manager
reconstructs managed Issues, native PR closing links, workflow runs and durable
comment events. A separate policy engine gates every action. No database or
server is required.

The included worker validates a task and computes a real SHA-256 digest. It never
edits application code. Success moves the task to `awaiting-pr`; only verified
completion evidence closes it. Coding/review workers and automatic PR merging
are outside this release.

## Install in a target repository

Requirements: Issues and Actions enabled, access to the public reusable workflow,
and Node.js 22.12+ for local development. Installed workflows run Node 22.

1. Choose a reviewed immutable harness commit. Clone this repository, run
   `npm ci --ignore-scripts`, then generate the **two target files**:

   ```sh
   npx tsx scripts/install.ts --directory /path/to/target --ref FULL_40_CHARACTER_COMMIT_SHA
   ```

   The installer preserves existing files. Alternatively copy `templates/harness.yml`
   to `.github/harness.yml` and `templates/harness-manager.yml` to
   `.github/workflows/harness-manager.yml`. Replace **both** `HARNESS_COMMIT_SHA`
   placeholders with the same SHA. The `uses` pin selects workflow logic and
   `harness-ref` selects runtime code; keep them equal when upgrading. Resolve a
   release tag such as `v0.1.0` to its commit before production installation.
2. Review scope/configuration and merge these files into the target's **default
   branch**. Defaults use supervised approval, the mock planner, one worker, and
   no paid API calls.
3. Allow explicit permissions: `contents: read`, `issues: write`,
   `pull-requests: read`, `actions: write`. The worker downgrades them. No PAT or
   extra GitHub App is needed for the public harness. Organization Actions
   allowlists must permit the called workflows and actions.
4. Run **Actions → Dev Agent Harness → Run workflow**, `mode=bootstrap`.
   Missing labels are created; existing colors/descriptions are preserved.
   Repeated bootstrap is safe and never changes configuration.
5. Create an Issue with `harness:managed`, a clear description and this section:

   ```markdown
   ## Acceptance criteria
   - The test worker validates this task and publishes its digest.
   ```

   Add `Depends on: #12, #15` on its own line if needed. Dependencies, including
   unmanaged Issues, are read only and must be natively closed first.
6. Dispatch `mode=manager`. The Actions summary and durable decision comment
   contain the proposed `start_worker` action ID. A repository writer, maintainer
   or administrator approves **that exact action** with a full Issue comment:

   ```text
   /harness approve FULL_64_CHARACTER_ACTION_ID
   ```

   `/harness revoke FULL_64_CHARACTER_ACTION_ID` revokes it; last authorized
   command wins. Title/body changes, effective configuration changes, and each
   new retry attempt invalidate approval. A ready label alone is not approval.
   Run the manager again to dispatch the worker.
7. When the asynchronous worker ends, another manager run processes its durable
   result and updates lifecycle. The schedule also performs reconciliation.

Default cron is `17 */2 * * *` (UTC). Change cron **in the target workflow** to
change scheduling; runtime configuration cannot register cron. GitHub may delay
schedules or disable them for inactive public repositories. Preserve the wrapper's
run-name and concurrency expressions: they implement correlation and locking.

## OpenAI planning

Set `llm.provider: openai`, choose a Structured Outputs compatible model, and add
the target secret `OPENAI_API_KEY`. The wrapper explicitly passes only this secret
to the manager, never the worker. Use `reasoningEffort: null` for models without
that capability. The adapter calls the real Responses API with strict JSON schema,
no tools, bounded context, timeouts and bounded retries. Deterministic
reconciliation remains available when semantic planning fails.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm run schemas
npm audit --audit-level=moderate
```

CI also runs checksum-verified `actionlint` against workflows and the template.
Tests simulate the GitHub port and Octokit's REST/GraphQL transport, including
accepted dispatch followed by connection loss. See [verification](docs/verification.md).

Validate offline: `node dist/cli.js validate --file templates/harness.yml`.
With `GITHUB_TOKEN`, local previews use
`node dist/cli.js manager --repository owner/name --dry-run`. Local mutations need
`--allow-local-writes` and an exclusive operator session with scheduled managers
disabled. Production operations should use the serialized wrapper.

Read [configuration](docs/configuration.md), [architecture](docs/architecture.md),
[security](docs/security.md), and [operations/recovery](docs/operations.md) before
extending a worker. GitHub branch protection and rulesets remain authoritative.
