# Separation from the v0.1 orchestrator

The former manager, OpenAI/mock planning, project autonomy policies, Issue/PR
reconciliation, GitHub persistence, worker dispatch/supervision, retries, schedule,
bootstrap, installation templates and their tests moved to
`munichdeveloper/software-factory`. They are removed from this runtime's source,
dependencies, schemas and workflows. Import provenance is the merged v0.1 commit
`615fbee4775c3eea46270531d8a13648d998d835`.

Contract 2.0 describes an opaque task and a single run. It contains no GitHub
repository, Issue number, Factory action proposals or project autonomy profile.
SF maps its durable delegation envelope to this protocol and maps results back;
legacy GitHub journals remain SF's responsibility. Do not point an old v0.1
manager wrapper at this runtime commit. Install the SF wrapper and configuration
following its migration guide, pinning SF and Harness independently.

The runtime does not start another worker, update Issues, read repository state,
choose priorities or retry a failed execution. Its per-run deadline and capability
checks enforce the caller's technical execution envelope.
