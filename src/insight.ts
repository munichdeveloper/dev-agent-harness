// What a coding run did, for judging later whether its cost fit the task (Software Factory cost evaluation, #19):
// which tools ran in which order and on which file, what the first request cost as fixed context, and how large the
// resulting change is. Tool inputs and outputs never enter the record: only tool names, workspace-relative file paths
// and the first word of a shell command, each validated against a strict pattern, so task text, file contents, command
// arguments and anything secret-shaped stay out.
import { isAbsolute, relative } from 'node:path';
import { z } from 'zod';

const count = z.number().int().min(0).max(1e12);
export const maxTraceEntries = 1000;
export const maxDiffFiles = 200;
const pathPattern = /^[A-Za-z0-9._@+/-]{1,300}$/;

export const traceEntrySchema = z.strictObject({
  /** Number of the assistant message (1-based) that called the tool. */
  turn: count,
  tool: z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/),
  /** Workspace-relative file or directory (Read, Edit, Write, Grep, Glob, NotebookEdit) or the command word (Bash). */
  target: z.string().regex(pathPattern).nullable(),
  /** The tool result reported an error (a failed command, a missing file). */
  error: z.boolean()
});
export const diffFileSchema = z.strictObject({
  path: z.string().min(1).max(500), added: count.nullable(), removed: count.nullable()
});
export const insightSchema = z.strictObject({
  trace: z.array(traceEntrySchema).max(maxTraceEntries), traceTruncated: z.boolean(),
  /** Input tokens of the first model request (uncached + cache read + cache write): the fixed context every request carries. */
  firstRequestInputTokens: count.nullable(),
  /** Output tokens per assistant message, in order (bounded like the trace). */
  outputTokensPerTurn: z.array(count).max(maxTraceEntries),
  diff: z.array(diffFileSchema).max(maxDiffFiles).nullable(), diffTruncated: z.boolean()
});
export type TraceEntry = z.infer<typeof traceEntrySchema>;
export type DiffFile = z.infer<typeof diffFileSchema>;
export type Insight = z.infer<typeof insightSchema>;

const int = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** A file path from a tool input, relative to the workspace; null when absent, outside it or not a plain path. */
export function toolPath(value: unknown, workspace: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) return null;
  const path = isAbsolute(value) ? relative(workspace, value) : value;
  if (path === '') return '.';
  if (path.startsWith('..') || isAbsolute(path)) return null;
  return pathPattern.test(path) ? path : null;
}

/** The program a shell command starts with (after leading variable assignments and `cd …&&`), e.g. npm, git, node. */
export function commandWord(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const words = value.trim().split(/\s+/);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  if (words[index] === 'cd' && words[index + 2] === '&&') index += 3;
  const word = (words[index] ?? '').replace(/^.*\//, '');
  return /^[A-Za-z0-9._-]{1,40}$/.test(word) ? word : null;
}

function target(tool: string, input: unknown, workspace: string): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  if (tool === 'Bash') return commandWord(i.command);
  return toolPath(i.file_path ?? i.notebook_path ?? i.path, workspace);
}

/** Reads Claude Code's stream-json output (one event per line) into a bounded, content-free trace. */
export function claudeTrace(lines: string[], workspace: string): Pick<Insight, 'trace' | 'traceTruncated' | 'firstRequestInputTokens' | 'outputTokensPerTurn'> {
  const trace: TraceEntry[] = [], outputTokensPerTurn: number[] = [], byId = new Map<string, TraceEntry>();
  let turn = 0, truncated = false, firstRequestInputTokens: number | null = null;
  for (const line of lines) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    const e = event as { type?: unknown; message?: { content?: unknown; usage?: Record<string, unknown> } };
    const content = Array.isArray(e.message?.content) ? e.message.content as unknown[] : [];
    if (e.type === 'assistant') {
      turn += 1;
      const usage = e.message?.usage;
      if (usage) {
        if (firstRequestInputTokens === null) firstRequestInputTokens = int(usage.input_tokens) + int(usage.cache_read_input_tokens) + int(usage.cache_creation_input_tokens);
        if (outputTokensPerTurn.length < maxTraceEntries) outputTokensPerTurn.push(int(usage.output_tokens));
      }
      for (const block of content) {
        const b = block as { type?: unknown; name?: unknown; id?: unknown; input?: unknown };
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
        if (trace.length >= maxTraceEntries) { truncated = true; continue; }
        const tool = /^[A-Za-z0-9_.-]{1,60}$/.test(b.name) ? b.name : 'unknown';
        const entry: TraceEntry = { turn, tool, target: target(tool, b.input, workspace), error: false };
        trace.push(entry);
        if (typeof b.id === 'string') byId.set(b.id, entry);
      }
    } else if (e.type === 'user') {
      for (const block of content) {
        const b = block as { type?: unknown; tool_use_id?: unknown; is_error?: unknown };
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && b.is_error === true) {
          const entry = byId.get(b.tool_use_id);
          if (entry) entry.error = true;
        }
      }
    }
  }
  return { trace, traceTruncated: truncated, firstRequestInputTokens, outputTokensPerTurn };
}

/** `git diff --numstat -z` output: per file added and removed lines; binary files have neither. */
export function numstat(output: string): DiffFile[] {
  const fields = output.split('\0'), files: DiffFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field);
    if (!match) continue;
    let path = match[3]!;
    // A rename has an empty path field followed by the old and the new path.
    if (path === '') { path = fields[index + 2] ?? ''; index += 2; }
    if (!path) continue;
    files.push({ path: path.slice(0, 500), added: match[1] === '-' ? null : Number(match[1]), removed: match[2] === '-' ? null : Number(match[2]) });
  }
  return files;
}

/** Lines of a new (untracked) file; null for binary content. */
export function newFileLines(bytes: Buffer): number | null {
  if (bytes.includes(0)) return null;
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 10) lines += 1;
  return bytes[bytes.length - 1] === 10 ? lines : lines + 1;
}

export function boundedDiff(files: DiffFile[]): Pick<Insight, 'diff' | 'diffTruncated'> {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return { diff: sorted.slice(0, maxDiffFiles), diffTruncated: sorted.length > maxDiffFiles };
}
