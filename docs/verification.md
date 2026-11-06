# Verification

Automated tests cover all 20 requested categories: empty repo, runnable task,
active worker, merged closing PR, unmerged closed PR, dependencies, worker
failure/timeout, repeated manager, duplicate follow-up, invalid config, limits,
three profiles, overrides, prompt injection, LLM failure, interrupted dispatch
and subsequent reconstruction.

Additional tests cover Octokit HTTP pagination, cross-repository closing links,
bootstrap idempotency, approval authorship/version invalidation, retry-specific
approval IDs, protocol validation, actual digest correctness, asynchronous
success, native closure, dry run/global disable, and nested default isolation.

Commands: `npm run check`, `npm run test:coverage`, `npm run schemas`,
`npm audit --audit-level=moderate`, checksum-verified `actionlint v1.7.12`.
CI repeats checks on Node 22 and rejects generated-schema drift.

Real GitHub evidence will be recorded after the dedicated test installation.
No production target is used. OpenAI HTTPS transport is simulated unless a
configured API secret is available; no billed live-call claim is made.
