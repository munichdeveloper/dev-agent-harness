import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { browserCacheDirectory, claudeMessage, codingMessageSchema, codingPrompt, codingRequestSchema, codingWorkers, collectCodingArtifact, diffStat } from './coding.js';
import { claudeTrace, fitInsight, insightSchema, type Insight } from './insight.js';
import { rejectionReason } from './rejection.js';
import { claudeOutcome, codexSessionTokens, proxyUsageSchema, usageRecordSchema } from './usage.js';

async function optional(path: string, limit: number): Promise<string | null> {
  try { return (await stat(path)).size > limit ? null : await readFile(path, 'utf8'); } catch { return null; }
}

/**
 * The trace and change size of the run. Both files were written by or from the worker, so they are parsed into the strict,
 * content-free insight schema; anything that does not fit is dropped rather than failing the usage record.
 */
async function runInsight(directory: string, worker: 'claude' | 'codex'): Promise<Insight | null> {
  let trace: ReturnType<typeof claudeTrace> = { trace: [], traceTruncated: false, firstRequestInputTokens: null, outputTokensPerTurn: [] };
  if (worker === 'claude') {
    const stream = await optional(resolve(directory, 'claude-stream.jsonl'), 64000000);
    if (stream !== null) trace = claudeTrace(stream.split('\n'), process.env.HARNESS_WORKSPACE ?? '/nonexistent');
  }
  let diff: Pick<Insight, 'diff' | 'diffTruncated'> = { diff: null, diffTruncated: false };
  const stat = await optional(resolve(directory, 'diffstat.json'), 1000000);
  try {
    const parsed = stat === null ? null : insightSchema.pick({ diff: true, diffTruncated: true }).safeParse(JSON.parse(stat));
    if (parsed?.success) diff = parsed.data;
  } catch { /* malformed: size unknown */ }
  const insight = insightSchema.safeParse({ ...trace, ...diff });
  return insight.success ? fitInsight(insight.data) : null;
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const directory = resolve(process.env.RUNNER_TEMP!, `harness-${process.env.HARNESS_EXECUTION_ID}`);
  if (command === 'prepare') {
    const request = codingRequestSchema.parse(JSON.parse(process.env.HARNESS_REQUEST ?? ''));
    if (request.executionId !== process.env.HARNESS_EXECUTION_ID) throw new Error('Execution mismatch');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'request.json'), JSON.stringify(request));
    const loopback = z.enum(['true', 'false']).parse(process.env.HARNESS_LOOPBACK || 'false') === 'true';
    await writeFile(resolve(directory, 'prompt.txt'), codingPrompt(request, loopback));
    // Claude Code validates against draft-07 and rejects the 2020-12 meta-schema reference; the schema itself is the same.
    const { $schema, ...messageSchema } = z.toJSONSchema(codingMessageSchema);
    await writeFile(resolve(directory, 'message.schema.json'), JSON.stringify(request.worker === 'claude' ? messageSchema : { $schema, ...messageSchema }));
    await appendFile(process.env.GITHUB_OUTPUT!, `directory=${directory}\nworker=${request.worker}\naccount=${codingWorkers[request.worker].account}\nmodel=${request.model}\neffort=${request.effort}\ntimeout=${request.limits.timeoutMinutes}\nbudget=${request.limits.maxCostUsd ?? ''}\nprofile=${loopback ? 'harness-loopback' : ':workspace'}\nloopback=${loopback}\n`);
  } else if (command === 'collect') {
    const request = codingRequestSchema.parse(JSON.parse(await readFile(resolve(directory, 'request.json'), 'utf8')));
    // Codex writes the message itself; for Claude the runner captured the print-mode result outside the worker's reach.
    const file = resolve(directory, request.worker === 'claude' ? 'claude.json' : 'output/message.json');
    if ((await stat(file)).size > (request.worker === 'claude' ? 2000000 : 16000)) throw new Error('Message too large');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const message = request.worker === 'claude' ? claudeMessage(parsed) : parsed;
    const result = await collectCodingArtifact(request, process.env.HARNESS_WORKSPACE!, message);
    await writeFile(resolve(directory, 'output/artifact.json'), JSON.stringify(result));
    // Change size for the cost evaluation; best effort, never fails the collection.
    try { await writeFile(resolve(directory, 'output/diffstat.json'), JSON.stringify(await diffStat(request.baseSha, process.env.HARNESS_WORKSPACE!))); }
    catch { /* no change size */ }
  } else if (command === 'usage') {
    // Runs as the runner account after the agent stopped, whether it succeeded or not. Every input is optional.
    const request = codingRequestSchema.parse(JSON.parse(await readFile(resolve(directory, 'request.json'), 'utf8')));
    const budgetUsd = request.worker === 'claude' ? request.limits.maxCostUsd ?? null : null;
    let measured: { source: 'proxy' | 'codex-session'; requests: number; tokens: z.infer<typeof proxyUsageSchema>['tokens'] } | null = null;
    let outcome: ReturnType<typeof claudeOutcome> = { costUsd: null, turns: null, durationMs: null, outcome: null };
    if (request.worker === 'claude') {
      const proxy = await optional(resolve(directory, 'proxy-usage.json'), 1000000);
      const parsed = proxy === null ? null : proxyUsageSchema.safeParse(JSON.parse(proxy));
      if (parsed?.success) measured = { source: 'proxy', requests: parsed.data.requests, tokens: parsed.data.tokens };
      const result = await optional(resolve(directory, 'claude.json'), 2000000);
      try { if (result) outcome = claudeOutcome(JSON.parse(result)); } catch { /* no result line */ }
    } else {
      const session = await optional(resolve(directory, 'codex-session.jsonl'), 64000000);
      const tokens = session === null ? null : codexSessionTokens(session.split('\n'));
      if (tokens) measured = { source: 'codex-session', ...tokens };
    }
    const insight = await runInsight(directory, request.worker);
    const record = usageRecordSchema.parse({ contractVersion: '1.0', executionId: request.executionId, worker: request.worker,
      model: request.model, effort: request.effort, source: measured?.source ?? null, requests: measured?.requests ?? null,
      tokens: measured?.tokens ?? null, ...outcome, budgetUsd, budgetReached: outcome.outcome === 'error_max_budget_usd',
      ...(insight ? { insight } : {}) });
    await writeFile(resolve(directory, 'usage.json'), JSON.stringify(record));
    const tokens = record.tokens;
    console.log(`usage: worker=${record.worker} model=${record.model} effort=${record.effort} requests=${record.requests ?? '-'}` +
      ` input=${tokens?.input ?? '-'} output=${tokens?.output ?? '-'} cache_read=${tokens?.cacheRead ?? '-'} cache_write=${tokens?.cacheWrite ?? '-'}` +
      ` cost_usd=${record.costUsd ?? '-'} turns=${record.turns ?? '-'} outcome=${record.outcome ?? '-'} budget_usd=${record.budgetUsd ?? '-'}` +
      ` trace=${record.insight ? record.insight.trace.length : '-'} first_request_input=${record.insight?.firstRequestInputTokens ?? '-'}` +
      ` diff_files=${record.insight?.diff?.length ?? '-'}`);
  } else if (command === 'browser-cache') {
    console.log(await browserCacheDirectory(process.env.HARNESS_BROWSER_CACHE ?? '', [process.env.RUNNER_TEMP, process.env.HOME]));
  } else throw new Error('Invalid coding command');
}
main().catch((error: unknown) => { console.error(`Coding request or artifact rejected: ${rejectionReason(error)}`); process.exitCode = 1; });
