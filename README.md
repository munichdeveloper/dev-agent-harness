# Dev Agent Harness

Version **0.3.0**, test execution contract **2.0**, coding request/artifact **3.0**. Execute one explicitly supplied
worker request and return one structured result. This package has no task queue,
project scope, planner, approvals, repository lifecycle, scheduling, retry policy
or worker supervision. Those functions live in
[Software Factory](https://github.com/munichdeveloper/software-factory).

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js run --input examples/request.json
```

The CLI also accepts JSON on stdin. `--output PATH` creates a result file without
overwriting an existing file. Invalid input exits 2 without logging its contents.
A valid terminal worker result, including failure, exits 0: the caller decides
what that status means and whether another execution should be scheduled.

Library callers can import `execute` and the request/result schemas from
`dist/index.js`. The bundled test worker computes a real digest and supports
deterministic failure/block outcomes. A trusted handler can be passed to `execute` explicitly;
repository content is never loaded as executable code.

Per-run capability, input, timeout, cancellation, output-size and result-schema
checks are enforced. The library deadline is cooperative; the SF process adapter
also applies a hard subprocess deadline. This runtime is not an OS sandbox for
arbitrary hostile code. The test CLI requires no GitHub or OpenAI credentials.

The root composite Action executes one real **Codex** coding request on a disposable
Linux runner. It pins the official `openai/codex-action` and Codex CLI 0.167.0,
runs with the `:workspace` permission profile as a separate non-sudo account, and
passes the OpenAI key only to the official Responses API proxy. A per-run watchdog
enforces the requested deadline. The caller must also set a job timeout (35 minutes
maximum), checkout the exact `baseSha` to `target` with `persist-credentials: false`,
and grant only contents-read permissions to this job. No repository-write token
belongs in the execution job. Model and reasoning effort are explicit request fields.

The Action returns a schema-validated result and a bounded base64 file manifest
(100 files / 5 MB maximum), including additions, deletions and committed changes.
Collection also runs under the restricted account, because Git configuration and
filters are untrusted after agent execution. No GitHub writes occur here. Callers
must validate paths/correlation and authorize publication in a fresh job; SF provides
that integration. Coding success is an implementation proposal, not review or merge.

The optional `.github/workflows/run.yml` is a reusable single-execution adapter,
with contents-read only and a structured result output. Its caller owns triggers,
dispatch, concurrency and persistence. Pin both workflow and `harness-ref` to the
same immutable commit. Software Factory uses the same standalone CLI protocol.

Checks: `npm run check`, `npm run test:coverage`, `npm run schemas`,
`npm audit --audit-level=moderate`. See [migration](docs/migration.md) and the
generated [request](schemas/request.schema.json)/[result](schemas/result.schema.json) schemas.
