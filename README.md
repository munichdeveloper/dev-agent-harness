# Dev Agent Harness

Version **0.2.0**, execution contract **2.0**. Execute one explicitly supplied
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
deterministic failure/block outcomes. Productive coding/review workers remain
outside this release. A trusted handler can be passed to `execute` explicitly;
repository content is never loaded as executable code.

Per-run capability, input, timeout, cancellation, output-size and result-schema
checks are enforced. The library deadline is cooperative; the SF process adapter
also applies a hard subprocess deadline. This runtime is not an OS sandbox for
arbitrary hostile code. It requires no GitHub or OpenAI credentials.

The optional `.github/workflows/run.yml` is a reusable single-execution adapter,
with contents-read only and a structured result output. Its caller owns triggers,
dispatch, concurrency and persistence. Pin both workflow and `harness-ref` to the
same immutable commit. Software Factory uses the same standalone CLI protocol.

Checks: `npm run check`, `npm run test:coverage`, `npm run schemas`,
`npm audit --audit-level=moderate`. See [migration](docs/migration.md) and the
generated [request](schemas/request.schema.json)/[result](schemas/result.schema.json) schemas.
