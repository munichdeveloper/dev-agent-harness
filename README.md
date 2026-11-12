# Dev Agent Harness

Version **0.3.2**, test execution contract **2.0**, coding request/artifact **3.0**. Execute one explicitly supplied
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

Commands cannot open sockets by default. `codex exec` would trust a writable checkout and load its
`.codex/config.toml`, which can start host processes outside the command sandbox (for example
`mcp_servers`) with ordinary network and a path to the API proxy. Every run therefore seeds
`/home/codex-worker/.codex/config.toml` with the checkout marked untrusted before Codex starts: project-level
Codex configuration, hooks and exec policies of the target repository are not loaded, `AGENTS.md` still is.
`scripts/test-coding-home.sh` shows with a real `codex exec` against a stand-in API that such a server is
started without the entry and not with it.

With `loopback: 'true'` (default `false`) commands run in a
private network namespace that only has `lo`: a dev server and a headless browser test on 127.0.0.1
work, while other addresses, DNS and the host loopback with the API proxy stay unreachable. This uses
Codex's experimental managed networking (`features.network_proxy`) with an empty domain allowlist.
Because a profile with network enabled is unrestricted without that feature, the Action also
verifies the isolation with a probe before
the model starts, and limits the account to loopback without DNS through `iptables`. That last layer
alone would not hide the API proxy. `browser-cache` names a directory of Playwright browsers the
caller installed under `RUNNER_TEMP` or `HOME`; it is bind-mounted read-only at
`/home/codex-worker/.cache/ms-playwright`. Set both only in the reviewed caller workflow, never from
the request. `scripts/test-coding-loopback.sh` exercises both on a runner without API credentials.

For GitHub App dispatches, a reviewed caller may set `trusted-bot-users` to the
explicit App bot login. The default is empty. Never derive this value from the
request, issue text, or `github.actor`; that would authorize an arbitrary actor.
This forwards the pinned official Codex Action's `allow-bot-users` input without
granting repository write permissions to the coding job. The Temporal caller
separately validates immutable inputs and requires its authenticated human gate.

The optional `.github/workflows/run.yml` is a reusable single-execution adapter,
with contents-read only and a structured result output. Its caller owns triggers,
dispatch, concurrency and persistence. Pin both workflow and `harness-ref` to the
same immutable commit. Software Factory uses the same standalone CLI protocol.

Checks: `npm run check`, `npm run test:coverage`, `npm run schemas`,
`npm audit --audit-level=moderate`. See [migration](docs/migration.md) and the
generated [request](schemas/request.schema.json)/[result](schemas/result.schema.json) schemas.
