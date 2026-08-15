# Session Data Import (.md / .csv) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user restore session history from a file Heartwood itself exported (History → Export → Markdown/CSV), merged into whatever local data already exists.

**Architecture:** Export format bumps to version 4 (CSV gets a version marker + ISO dates; Markdown gets a hidden, invisible base64-encoded JSON block carrying the exact `ExportData`). A new pure `import.ts` parses either format back into `ExportData`. A new `importApply.ts` orchestrates the merge against the live repository (skip-existing by id, auto-create missing projects, write notes only for newly-inserted sessions). Two new repository functions (`insertImportedSession`, `insertParkedThoughtIfAbsent`) give idempotent, id-keyed inserts across all three repository files. `History.svelte` gets an Import button; `App.svelte` wires it to the repository, refreshes state, and reports a summary.

**Tech Stack:** Svelte 5 (runes), TypeScript, `@tauri-apps/plugin-dialog` (`open`), `@tauri-apps/plugin-fs` (`readTextFile`), Vitest.

## Global Constraints

- Export format version bumps from 3 to 4 (`export.ts`'s `EXPORT_FORMAT_VERSION`). Files exported before this version are rejected on import with a clear message — never best-effort parsed.
- Import never overwrites anything that already exists locally. Sessions and parked thoughts are matched by `id`; an existing id is skipped entirely (no session write, no note write, no project resolution for it).
- Every repository write import performs must go through the same `writeQueue.enqueue(...)` FIFO serialization every other mutation in `App.svelte` already uses — see `src/App.svelte`'s `writeQueue` (defined line ~401, used at every `saveSession`/`saveNote`/`insertParkedThought`/etc. call site).
- `project_id` is set only via the existing dedicated `updateSessionProject` UPDATE, never written as part of a session insert — matches the standing architectural boundary already documented on `SessionRow.project_id` in `src/lib/persistence.ts`.
- New repository functions are added to all three files in the existing dispatch pattern: `src/lib/tauriRepository.ts` (real), `src/lib/memoryRepository.ts` (browser-dev fallback), `src/lib/repository.ts` (runtime dispatcher). Never add a function to only one.
- Test files: this filesystem is case-insensitive. `import.ts`/`import.test.ts` and `importApply.ts`/`importApply.test.ts` are new, unique names — safe. Do **not** create `History.test.ts` (collides with the existing `history.test.ts`) — new History.svelte-level tests go in a new file named `HistoryImport.test.ts`, matching the existing `HistoryTabs.test.ts` convention for the same reason.
- No raw hex/rgb color literals in `.svelte` files — only `var(--token)` references (enforced by `appearanceTokens.test.ts`'s "no component hardcodes a raw CSS color" test). Any new UI styling must use existing tokens (`--danger`, `--text-muted`, `--surface`, etc.), never a new hardcoded color.

---

### Task 1: Export format version 4 (CSV version marker + ISO dates, Markdown hidden data block)

**Files:**
- Modify: `src/lib/export.ts`
- Test: `src/lib/export.test.ts` (existing file — extend)

**Interfaces:**
- Produces: `EXPORT_FORMAT_VERSION = 4`. `formatExportAsCsv` output now starts with a `Heartwood Export,4,<isoExportedAt>` line, then a blank line, then the existing `Sessions` section unchanged in structure except `completedAt`/`createdAt` columns are now ISO 8601 strings. `formatExportAsMarkdown` output now starts with `<!-- heartwood-export-data:<base64> -->` (single line) followed by a blank line, then the existing `# Heartwood Export` heading unchanged. A new exported helper `encodeBase64(text: string): string` (UTF-8 safe) is added for Task 2's parser to mirror with a decoder.

- [ ] **Step 1: Write failing tests for the CSV version line and ISO dates**

Add to `src/lib/export.test.ts`, inside the existing `describe('formatExportAsCsv', ...)` block:

```ts
  it('starts with a version marker line', () => {
    const csv = formatExportAsCsv(buildExportData([], [], 1_700_000_100_000));
    const firstLine = csv.split('\n')[0];
    expect(firstLine).toBe(`Heartwood Export,${EXPORT_FORMAT_VERSION},${new Date(1_700_000_100_000).toISOString()}`);
  });

  it('renders completedAt and parked-thought createdAt as ISO 8601, not locale text', () => {
    const data = buildExportData(
      [summary({ id: 's1', completedAt: 1_700_000_000_000 })],
      [thought({ id: 't1', createdAt: 1_700_000_000_000 })],
      1_700_000_100_000,
    );
    const csv = formatExportAsCsv(data);
    const iso = new Date(1_700_000_000_000).toISOString();
    expect(csv).toContain(`s1,Write the report,${iso}`);
    expect(csv).toContain(`t1,,Check on the deploy,${iso}`);
  });
```

- [ ] **Step 2: Run the new tests, confirm they fail**

Run: `npx vitest run src/lib/export.test.ts`
Expected: FAIL — no version line yet, dates still locale-formatted.

- [ ] **Step 3: Bump the version and update `formatExportAsCsv`**

In `src/lib/export.ts`, change:

```ts
export const EXPORT_FORMAT_VERSION = 3;
```

to:

```ts
export const EXPORT_FORMAT_VERSION = 4;
```

Then in `formatExportAsCsv`, replace the start of the function body:

```ts
export function formatExportAsCsv(data: ExportData): string {
  const lines: string[] = [];

  lines.push('Sessions');
```

with:

```ts
export function formatExportAsCsv(data: ExportData): string {
  const lines: string[] = [];

  // Only version stamp anywhere in the CSV's own visible output — without
  // it, import.ts's parseImportedCsv would have no way to distinguish an
  // old (pre-import-support) file from a new one; ExportData.version alone
  // is never printed to CSV.
  lines.push(`Heartwood Export,${EXPORT_FORMAT_VERSION},${new Date(data.exportedAt).toISOString()}`);
  lines.push('');

  lines.push('Sessions');
```

Then change the two `formatDateTime(...)` calls inside `formatExportAsCsv` (the session row's `completedAt` and the parked-thought row's `createdAt`) to `new Date(...).toISOString()`:

```ts
        formatDateTime(session.completedAt),
```
→
```ts
        new Date(session.completedAt).toISOString(),
```

```ts
    lines.push(csvRow([thought.id, thought.sessionId ?? '', thought.text, formatDateTime(thought.createdAt)]));
```
→
```ts
    lines.push(csvRow([thought.id, thought.sessionId ?? '', thought.text, new Date(thought.createdAt).toISOString()]));
```

- [ ] **Step 4: Run tests, confirm the CSV tests pass**

Run: `npx vitest run src/lib/export.test.ts`
Expected: PASS for the two new tests. The existing `'includes both table headers'` test still passes unchanged (it doesn't check the first line). No other existing CSV test asserts on `formatDateTime` output for these two fields, so nothing else breaks — verify by running the full file.

- [ ] **Step 5: Write failing tests for the Markdown hidden data block**

Add to `src/lib/export.test.ts`, inside `describe('formatExportAsMarkdown', ...)`:

```ts
  it('embeds the full export data as a hidden, invisible base64 block before the heading', () => {
    const data = buildExportData(
      [summary({ id: 's1', task: 'Write the report' })],
      [thought({ id: 't1' })],
      1_700_000_100_000,
    );
    const md = formatExportAsMarkdown(data);

    const match = md.match(/^<!-- heartwood-export-data:([A-Za-z0-9+/=]+) -->/);
    expect(match).not.toBeNull();
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(match![1]), (c) => c.charCodeAt(0)));
    expect(JSON.parse(decoded)).toEqual(data);

    // Invisible: an HTML comment, never inside the prose a reader sees.
    expect(md.indexOf('<!-- heartwood-export-data:')).toBe(0);
    expect(md).toContain('# Heartwood Export');
  });

  it('round-trips task/note text containing "-->" without corrupting the hidden block', () => {
    const data = buildExportData(
      [summary({ id: 's1', task: 'Ship it --> done', noteContent: 'edge --> case' })],
      [],
      1_700_000_100_000,
    );
    const md = formatExportAsMarkdown(data);
    const match = md.match(/^<!-- heartwood-export-data:([A-Za-z0-9+/=]+) -->/);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(match![1]), (c) => c.charCodeAt(0)));
    expect(JSON.parse(decoded).sessions[0].task).toBe('Ship it --> done');
  });
```

- [ ] **Step 6: Run, confirm failure**

Run: `npx vitest run src/lib/export.test.ts`
Expected: FAIL — no hidden block yet.

- [ ] **Step 7: Add `encodeBase64` and update `formatExportAsMarkdown`**

In `src/lib/export.ts`, add near the top (after the existing `csvRow` helper, before `formatExportAsCsv` or `formatExportAsMarkdown` — either is fine, keep helpers grouped):

```ts
/** UTF-8-safe base64 encode. Plain `btoa` throws on non-ASCII input (e.g.
 * a task title with an emoji or accented character), and a raw JSON string
 * embedded directly in an HTML comment risks a literal "-->" inside task
 * text or a note prematurely closing the comment. Base64's alphabet
 * (A-Za-z0-9+/=) can never contain "-->" or "<!--", so this sidesteps both
 * problems at once rather than escaping either one. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
```

Then replace the start of `formatExportAsMarkdown`:

```ts
export function formatExportAsMarkdown(data: ExportData): string {
  const lines: string[] = [];

  lines.push('# Heartwood Export');
```

with:

```ts
export function formatExportAsMarkdown(data: ExportData): string {
  const lines: string[] = [];

  // Invisible in every markdown renderer (it's an HTML comment) — carries
  // the exact ExportData JSON so import.ts's parseImportedMarkdown can
  // restore with full fidelity, without needing to parse or annotate the
  // human-readable prose below at all. See import.ts's matching decoder.
  lines.push(`<!-- heartwood-export-data:${encodeBase64(JSON.stringify(data))} -->`);
  lines.push('');

  lines.push('# Heartwood Export');
```

- [ ] **Step 8: Run tests, confirm all of `export.test.ts` passes**

Run: `npx vitest run src/lib/export.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 9: Run the full check and test suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass. (This step touches only `export.ts`, which nothing else in the codebase calls yet except `History.svelte`'s existing export buttons — those still work unchanged since `buildExportData`'s shape and the formatter function signatures are untouched.)

- [ ] **Step 10: Commit**

```bash
git add src/lib/export.ts src/lib/export.test.ts
git commit -m "feat: bump export format to v4 for lossless CSV/Markdown round-trip

CSV gains a version marker line and switches completedAt/createdAt to
ISO 8601 (was locale-formatted text, not reliably parseable). Markdown
gains a hidden, invisible base64-encoded data block carrying the exact
ExportData, so both formats can be read back with full fidelity by the
import feature landing in the next commits."
```

---

### Task 2: `import.ts` — parse both formats back into `ExportData`

**Files:**
- Create: `src/lib/import.ts`
- Test: `src/lib/import.test.ts`

**Interfaces:**
- Consumes: `ExportData`, `SessionExportEntry`, `ParkedThoughtExportEntry`, `EXPORT_FORMAT_VERSION`, `buildExportData`, `formatExportAsCsv`, `formatExportAsMarkdown` from `./export`.
- Produces:
  ```ts
  export type ImportParseResult = { ok: true; data: ExportData } | { ok: false; error: string };
  export function parseImportedMarkdown(content: string): ImportParseResult;
  export function parseImportedCsv(content: string): ImportParseResult;
  ```
  Task 4 (`importApply.ts`) and Task 5 (`History.svelte`) both call these two functions and consume `ImportParseResult`.

- [ ] **Step 1: Write failing round-trip tests**

Create `src/lib/import.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildExportData, formatExportAsCsv, formatExportAsMarkdown } from './export';
import { parseImportedCsv, parseImportedMarkdown } from './import';
import type { SessionSummary } from './history';
import type { ParkedThought } from './parkingLot';
import type { Project } from './projects';

const T0 = 1_700_000_000_000;

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    task: 'Write the report',
    completedAt: T0,
    plannedFocusMs: 25 * 60_000,
    actualFocusMs: 25 * 60_000,
    flowMs: 0,
    tookBreak: false,
    breakMs: 0,
    breakIntermissionMs: 0,
    touchGrassMs: 0,
    totalElapsedMs: 25 * 60_000,
    parkedThoughtCount: 0,
    noteContent: null,
    revisionCount: 0,
    projectId: null,
    ...overrides,
  };
}

function thought(overrides: Partial<ParkedThought> = {}): ParkedThought {
  return { id: 't1', sessionId: 's1', text: 'Check on the deploy', createdAt: T0, ...overrides };
}

describe('parseImportedMarkdown', () => {
  it('round-trips a full export exactly', () => {
    const project: Project = { id: 'p1', name: 'Q3 Launch', category: 'work', archivedAt: null, createdAt: T0 };
    const data = buildExportData(
      [summary({ id: 's1', projectId: 'p1', noteContent: 'Remember to follow up' })],
      [thought({ id: 't1' })],
      T0 + 100_000,
      [project],
    );
    const result = parseImportedMarkdown(formatExportAsMarkdown(data));
    expect(result).toEqual({ ok: true, data });
  });

  it('rejects a file with no hidden data block', () => {
    const result = parseImportedMarkdown('# Just some markdown\n\nNo hidden block here.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/older version|not a Heartwood export/i);
  });

  it('rejects a hidden block with an old version number', () => {
    const oldData = { version: 3, exportedAt: T0, sessions: [], parkedThoughts: [] };
    const b64 = btoa(JSON.stringify(oldData));
    const result = parseImportedMarkdown(`<!-- heartwood-export-data:${b64} -->\n\n# Heartwood Export`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/older version/i);
  });

  it('rejects corrupted base64/JSON without throwing', () => {
    const result = parseImportedMarkdown('<!-- heartwood-export-data:not-valid-base64!!! -->');
    expect(result.ok).toBe(false);
  });
});

describe('parseImportedCsv', () => {
  it('round-trips a full export exactly', () => {
    const project: Project = { id: 'p1', name: 'Q3 Launch', category: 'work', archivedAt: null, createdAt: T0 };
    const data = buildExportData(
      [summary({ id: 's1', projectId: 'p1', noteContent: 'Remember to follow up', breakIntermissionMs: 60_000 })],
      [thought({ id: 't1' })],
      T0 + 100_000,
      [project],
    );
    const result = parseImportedCsv(formatExportAsCsv(data));
    expect(result).toEqual({ ok: true, data });
  });

  it('round-trips a session with no project, no note, and a sessionless thought', () => {
    const sessionless = thought({ id: 't2', text: 'Random idea' });
    delete (sessionless as Partial<ParkedThought>).sessionId;
    const data = buildExportData([summary({ id: 's1' })], [sessionless], T0 + 100_000);
    const result = parseImportedCsv(formatExportAsCsv(data));
    expect(result).toEqual({ ok: true, data });
  });

  it('round-trips a note containing commas, quotes, and embedded newlines', () => {
    const data = buildExportData(
      [summary({ id: 's1', noteContent: 'Line one\nHas "quotes", and, commas' })],
      [],
      T0 + 100_000,
    );
    const result = parseImportedCsv(formatExportAsCsv(data));
    expect(result).toEqual({ ok: true, data });
  });

  it('rejects a CSV with no version marker line', () => {
    const result = parseImportedCsv('Sessions\nid,task\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/older version|not a Heartwood export/i);
  });

  it('rejects a CSV with an old version number', () => {
    const result = parseImportedCsv('Heartwood Export,3,2023-01-01T00:00:00.000Z\n\nSessions\nid,task\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/older version/i);
  });

  it('rejects a CSV missing the Currently Parked Thoughts section', () => {
    const result = parseImportedCsv(
      'Heartwood Export,4,2023-01-01T00:00:00.000Z\n\nSessions\nid,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category\n',
    );
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/import.test.ts`
Expected: FAIL — `./import` doesn't exist yet.

- [ ] **Step 3: Implement `src/lib/import.ts`**

```ts
// Pure parsers that reverse export.ts's formatExportAsCsv/formatExportAsMarkdown
// back into an ExportData object. No DOM, no repository access — matches
// export.ts's own separation of concerns. Never throws: every failure path
// returns { ok: false, error } with a message meant to be shown directly
// to the user.

import { EXPORT_FORMAT_VERSION, type ExportData, type ParkedThoughtExportEntry, type SessionExportEntry } from './export';

export type ImportParseResult = { ok: true; data: ExportData } | { ok: false; error: string };

const UNSUPPORTED_VERSION_ERROR =
  'This file was exported by an older version of Heartwood and can’t be imported. Re-export it from that version’s History screen, then try again.';
const NOT_AN_EXPORT_ERROR = 'This doesn’t look like a Heartwood export file.';
const CORRUPTED_ERROR = 'This export file is corrupted and couldn’t be read.';

function decodeBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isValidExportData(value: unknown): value is ExportData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'number' &&
    typeof v.exportedAt === 'number' &&
    Array.isArray(v.sessions) &&
    Array.isArray(v.parkedThoughts)
  );
}

const HIDDEN_BLOCK_RE = /^<!-- heartwood-export-data:([A-Za-z0-9+/=]+) -->/;

export function parseImportedMarkdown(content: string): ImportParseResult {
  const match = content.match(HIDDEN_BLOCK_RE);
  if (!match) return { ok: false, error: NOT_AN_EXPORT_ERROR };

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64(match[1]));
  } catch {
    return { ok: false, error: CORRUPTED_ERROR };
  }

  if (!isValidExportData(parsed)) return { ok: false, error: CORRUPTED_ERROR };
  if (parsed.version !== EXPORT_FORMAT_VERSION) return { ok: false, error: UNSUPPORTED_VERSION_ERROR };
  return { ok: true, data: parsed };
}

/** Hand-rolled CSV tokenizer mirroring export.ts's csvField/csvRow escaping
 * exactly (fields containing a comma, quote, or newline are wrapped in
 * quotes, with embedded quotes doubled). Operates on the whole file text
 * rather than splitting by line first, since a quoted field's own embedded
 * newlines (a multi-line note) must never be mistaken for a row boundary. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += char;
        i += 1;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
    } else if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else if (char === '\r') {
      i += 1;
    } else {
      field += char;
      i += 1;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const SESSION_HEADER = [
  'id', 'task', 'completedAt', 'plannedFocusMs', 'actualFocusMs', 'flowMs', 'breakMs',
  'breakIntermissionMs', 'touchGrassMs', 'totalElapsedMs', 'parkedThoughtCount',
  'parkedThoughts', 'noteContent', 'project', 'category',
];
const THOUGHT_HEADER = ['id', 'sessionId', 'text', 'createdAt'];

function parseIsoDate(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function parseImportedCsv(content: string): ImportParseResult {
  // Blank physical lines are section separators here, never data — a blank
  // line can never occur inside a quoted field without also being inside
  // an open quote (which parseCsvRows already keeps intact), so filtering
  // single-empty-field rows can't accidentally drop a real record.
  const rows = parseCsvRows(content).filter((r) => !(r.length === 1 && r[0] === ''));

  const versionRow = rows[0];
  if (!versionRow || versionRow[0] !== 'Heartwood Export') return { ok: false, error: NOT_AN_EXPORT_ERROR };
  if (versionRow[1] !== String(EXPORT_FORMAT_VERSION)) return { ok: false, error: UNSUPPORTED_VERSION_ERROR };
  const exportedAt = parseIsoDate(versionRow[2] ?? '');
  if (exportedAt === null) return { ok: false, error: CORRUPTED_ERROR };

  let i = 1;
  if (rows[i]?.[0] !== 'Sessions') return { ok: false, error: CORRUPTED_ERROR };
  i += 1;
  if (!rows[i] || rows[i].join(',') !== SESSION_HEADER.join(',')) return { ok: false, error: CORRUPTED_ERROR };
  i += 1;

  const sessions: SessionExportEntry[] = [];
  while (rows[i] && rows[i][0] !== 'Currently Parked Thoughts') {
    const r = rows[i];
    if (r.length !== SESSION_HEADER.length) return { ok: false, error: CORRUPTED_ERROR };
    const completedAt = parseIsoDate(r[2]);
    if (completedAt === null) return { ok: false, error: CORRUPTED_ERROR };
    const breakIntermissionMs = Number(r[7]);
    const touchGrassMs = Number(r[8]);
    sessions.push({
      id: r[0],
      task: r[1],
      completedAt,
      plannedFocusMs: Number(r[3]),
      actualFocusMs: Number(r[4]),
      flowMs: Number(r[5]),
      breakMs: Number(r[6]),
      ...(breakIntermissionMs > 0 ? { breakIntermissionMs } : {}),
      ...(touchGrassMs > 0 ? { touchGrassMs } : {}),
      totalElapsedMs: Number(r[9]),
      parkedThoughtCount: Number(r[10]),
      parkedThoughts: r[11] === '' ? [] : r[11].split('; '),
      noteContent: r[12] === '' ? null : r[12],
      projectName: r[13] === '' ? null : r[13],
      categoryLabel: r[14] === '' ? null : r[14],
    });
    i += 1;
  }

  if (rows[i]?.[0] !== 'Currently Parked Thoughts') return { ok: false, error: CORRUPTED_ERROR };
  i += 1;
  if (!rows[i] || rows[i].join(',') !== THOUGHT_HEADER.join(',')) return { ok: false, error: CORRUPTED_ERROR };
  i += 1;

  const parkedThoughts: ParkedThoughtExportEntry[] = [];
  while (rows[i]) {
    const r = rows[i];
    if (r.length !== THOUGHT_HEADER.length) return { ok: false, error: CORRUPTED_ERROR };
    const createdAt = parseIsoDate(r[3]);
    if (createdAt === null) return { ok: false, error: CORRUPTED_ERROR };
    parkedThoughts.push({
      id: r[0],
      ...(r[1] !== '' ? { sessionId: r[1] } : {}),
      text: r[2],
      createdAt,
    });
    i += 1;
  }

  return { ok: true, data: { version: EXPORT_FORMAT_VERSION, exportedAt, sessions, parkedThoughts } };
}
```

- [ ] **Step 4: Run tests, iterate until passing**

Run: `npx vitest run src/lib/import.test.ts`
Expected: PASS, all tests. If a round-trip test fails on a field mismatch, compare the failing field against `export.ts`'s exact serialization for that field (e.g. `SessionExportEntry.parkedThoughts` join character is `'; '` — must split on exactly that).

- [ ] **Step 5: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/import.ts src/lib/import.test.ts
git commit -m "feat: parse Heartwood's own .md/.csv exports back into ExportData

Pure parsers, mirroring export.ts's formatters exactly. Markdown reads
the hidden base64 data block; CSV re-parses its own two sections with a
hand-rolled tokenizer that respects quoted multi-line fields. Both
reject anything not version 4 with a clear, user-facing message."
```

---

### Task 3: Repository layer — `insertImportedSession` and `insertParkedThoughtIfAbsent`

**Files:**
- Modify: `src/lib/persistence.ts`, `src/lib/tauriRepository.ts`, `src/lib/memoryRepository.ts`, `src/lib/repository.ts`
- Test: `src/lib/memoryRepository.test.ts` (existing file — extend)

**Interfaces:**
- Consumes: nothing new from earlier tasks (this task is independent of Tasks 1-2).
- Produces:
  ```ts
  // persistence.ts
  export interface ImportedSessionFields {
    id: string;
    task: string;
    completedAt: number;
    plannedFocusMs: number;
    actualFocusMs: number;
    flowMs: number;
    breakMs: number;
    breakIntermissionMs: number;
    touchGrassMs: number;
    totalElapsedMs: number;
  }
  export type ImportOutcome = 'inserted' | 'skipped';

  // tauriRepository.ts, memoryRepository.ts, repository.ts
  export async function insertImportedSession(entry: ImportedSessionFields, now: number): Promise<ImportOutcome>;
  export async function insertParkedThoughtIfAbsent(thought: ParkedThought): Promise<ImportOutcome>;
  ```
  Task 4's `importApply.ts` calls both of these (via `./repository`).

- [ ] **Step 1: Write failing tests in `memoryRepository.test.ts`**

First read the existing file's imports and `beforeEach`/`resetMemoryStore()` pattern (every test file for this module resets state between tests — follow the same setup already present). Add:

```ts
describe('insertImportedSession', () => {
  const fields = {
    id: 's1',
    task: 'Imported task',
    completedAt: 1_700_000_000_000,
    plannedFocusMs: 25 * 60_000,
    actualFocusMs: 20 * 60_000,
    flowMs: 0,
    breakMs: 5 * 60_000,
    breakIntermissionMs: 60_000,
    touchGrassMs: 0,
    totalElapsedMs: 25 * 60_000,
  };

  it('inserts a new completed session row and returns "inserted"', async () => {
    const outcome = await insertImportedSession(fields, 1_700_000_100_000);
    expect(outcome).toBe('inserted');

    const rows = await loadCompletedSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 's1',
      task: 'Imported task',
      status: 'complete',
      completed_at: 1_700_000_000_000,
      planned_focus_ms: 25 * 60_000,
      actual_focus_ms: 20 * 60_000,
      break_ms: 5 * 60_000,
      break_intermission_ms: 60_000,
      total_elapsed_ms: 25 * 60_000,
    });
    // Set immediately so this row can never surface as a live review
    // screen if it ever becomes the most-recently-updated row.
    expect(rows[0].review_acknowledged_at).not.toBeNull();
  });

  it('skips and leaves the existing row untouched when the id already exists', async () => {
    await insertImportedSession(fields, 1_700_000_100_000);
    const outcome = await insertImportedSession({ ...fields, task: 'Different task' }, 1_700_000_200_000);
    expect(outcome).toBe('skipped');

    const rows = await loadCompletedSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].task).toBe('Imported task');
  });
});

describe('insertParkedThoughtIfAbsent', () => {
  const thought: ParkedThought = { id: 't1', sessionId: 's1', text: 'Imported thought', createdAt: 1_700_000_000_000 };

  it('inserts a new thought and returns "inserted"', async () => {
    const outcome = await insertParkedThoughtIfAbsent(thought);
    expect(outcome).toBe('inserted');
    expect(await loadAllParkedThoughts()).toEqual([thought]);
  });

  it('skips and leaves the existing thought untouched when the id already exists', async () => {
    await insertParkedThoughtIfAbsent(thought);
    const outcome = await insertParkedThoughtIfAbsent({ ...thought, text: 'Different text' });
    expect(outcome).toBe('skipped');

    const thoughts = await loadAllParkedThoughts();
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0].text).toBe('Imported thought');
  });
});
```

Add `insertImportedSession` and `insertParkedThoughtIfAbsent` to the file's existing top-of-file import from `./memoryRepository`.

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/memoryRepository.test.ts`
Expected: FAIL — functions don't exist yet.

- [ ] **Step 3: Export `EMPTY_ROW_FIELDS` and add `ImportedSessionFields`/`ImportOutcome` in `persistence.ts`**

In `src/lib/persistence.ts`, change:

```ts
const EMPTY_ROW_FIELDS = {
```

to:

```ts
export const EMPTY_ROW_FIELDS = {
```

(No other change to that object — every existing usage inside this file keeps working unchanged.)

Add near the top of the file, after the `SessionRow` interface:

```ts
/** The subset of an imported session's fields memoryRepository.ts and
 * tauriRepository.ts both need to insert a completed row directly —
 * bypassing serializeSessionState/the live timer state machine entirely,
 * since an imported session was never "in progress." Machine-only columns
 * (started_at, focus_completed_at, etc.) are never populated for these
 * rows; nothing reads them once review_acknowledged_at is set (see
 * insertImportedSession in both repository files). */
export interface ImportedSessionFields {
  id: string;
  task: string;
  completedAt: number;
  plannedFocusMs: number;
  actualFocusMs: number;
  flowMs: number;
  breakMs: number;
  breakIntermissionMs: number;
  touchGrassMs: number;
  totalElapsedMs: number;
}

export type ImportOutcome = 'inserted' | 'skipped';
```

- [ ] **Step 4: Implement in `memoryRepository.ts`**

Add to the imports at the top:

```ts
import {
  EMPTY_ROW_FIELDS,
  serializeSessionState,
  type ImportedSessionFields,
  type ImportOutcome,
  type SessionRow,
} from './persistence';
```

Add near `saveSession` (same section of the file):

```ts
export async function insertImportedSession(entry: ImportedSessionFields, now: number): Promise<ImportOutcome> {
  if (sessions.has(entry.id)) return 'skipped';
  sessions.set(entry.id, {
    id: entry.id,
    task: entry.task,
    status: 'complete',
    updated_at: now,
    ...EMPTY_ROW_FIELDS,
    completed_at: entry.completedAt,
    planned_focus_ms: entry.plannedFocusMs,
    actual_focus_ms: entry.actualFocusMs,
    flow_ms: entry.flowMs,
    // tookBreak was never part of the export format (a pre-existing gap
    // in export.ts, unrelated to import) — derived here as the closest
    // available signal rather than always false.
    took_break: entry.breakMs > 0 ? 1 : 0,
    break_ms: entry.breakMs,
    break_intermission_ms: entry.breakIntermissionMs,
    touch_grass_ms: entry.touchGrassMs,
    total_elapsed_ms: entry.totalElapsedMs,
    review_acknowledged_at: now,
  });
  return 'inserted';
}
```

Add near `insertParkedThought`:

```ts
export async function insertParkedThoughtIfAbsent(thought: ParkedThought): Promise<ImportOutcome> {
  if (parkedThoughts.some((t) => t.id === thought.id)) return 'skipped';
  parkedThoughts = [...parkedThoughts, thought];
  return 'inserted';
}
```

- [ ] **Step 5: Run memoryRepository tests, confirm pass**

Run: `npx vitest run src/lib/memoryRepository.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Implement in `tauriRepository.ts`**

Add to the existing `import { ... } from './persistence'` line: `type ImportedSessionFields, type ImportOutcome,`.

Add near `saveSession`:

```ts
/** Inserts a completed session row directly for import — see
 * ImportedSessionFields' own doc in persistence.ts for why this bypasses
 * serializeSessionState. ON CONFLICT DO NOTHING makes re-importing the
 * same file a no-op rather than an error or a silent overwrite. */
export async function insertImportedSession(entry: ImportedSessionFields, now: number): Promise<ImportOutcome> {
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO sessions (
      id, task, status, completed_at, planned_focus_ms, actual_focus_ms,
      flow_ms, took_break, break_ms, break_intermission_ms, touch_grass_ms,
      total_elapsed_ms, review_acknowledged_at, updated_at
    ) VALUES ($1, $2, 'complete', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
    ON CONFLICT(id) DO NOTHING`,
    [
      entry.id,
      entry.task,
      entry.completedAt,
      entry.plannedFocusMs,
      entry.actualFocusMs,
      entry.flowMs,
      entry.breakMs > 0 ? 1 : 0,
      entry.breakMs,
      entry.breakIntermissionMs,
      entry.touchGrassMs,
      entry.totalElapsedMs,
      now,
    ],
  );
  return result.rowsAffected > 0 ? 'inserted' : 'skipped';
}
```

Add near `insertParkedThought`:

```ts
export async function insertParkedThoughtIfAbsent(thought: ParkedThought): Promise<ImportOutcome> {
  const db = await getDb();
  const row = serializeParkedThought(thought);
  const result = await db.execute(
    'INSERT INTO parked_thoughts (id, session_id, text, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT(id) DO NOTHING',
    [row.id, row.session_id, row.text, row.created_at],
  );
  return result.rowsAffected > 0 ? 'inserted' : 'skipped';
}
```

- [ ] **Step 7: Wire up `repository.ts`**

Add two lines, alphabetically near the other session/parked-thought exports is not required — match the file's existing loose grouping (near `saveSession`/`insertParkedThought`):

```ts
export const insertImportedSession = backend.insertImportedSession;
export const insertParkedThoughtIfAbsent = backend.insertParkedThoughtIfAbsent;
```

- [ ] **Step 8: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/persistence.ts src/lib/tauriRepository.ts src/lib/memoryRepository.ts src/lib/repository.ts src/lib/memoryRepository.test.ts
git commit -m "feat: add idempotent id-keyed inserts for import

insertImportedSession and insertParkedThoughtIfAbsent, mirrored across
all three repository files. Both skip silently on an id collision
(ON CONFLICT DO NOTHING / in-memory has() check) rather than throwing —
the expected case for import's skip-existing merge policy, unlike the
live app's own insertParkedThought where a collision would be a bug."
```

---

### Task 4: `importApply.ts` — orchestrate the merge

**Files:**
- Create: `src/lib/importApply.ts`
- Test: `src/lib/importApply.test.ts`

**Interfaces:**
- Consumes: `ExportData` from `./export`; `insertImportedSession`, `insertParkedThoughtIfAbsent`, `insertProject`, `saveNote`, `updateSessionProject` from `./repository`; `Project`, `ProjectCategory`, `CATEGORY_LABELS` from `./projects`.
- Produces:
  ```ts
  export interface ImportSummary {
    sessionsImported: number;
    sessionsSkipped: number;
    thoughtsImported: number;
    thoughtsSkipped: number;
    projectsCreated: number;
  }
  export async function applyImportedData(data: ExportData, existingProjects: Project[], now: number): Promise<ImportSummary>;
  ```
  Task 6 (`App.svelte`) calls this, wrapped in `writeQueue.enqueue(...)`.

- [ ] **Step 1: Write failing tests**

Create `src/lib/importApply.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportData } from './export';
import type { Project } from './projects';

const {
  insertImportedSession,
  insertParkedThoughtIfAbsent,
  insertProject,
  saveNote,
  updateSessionProject,
} = vi.hoisted(() => ({
  insertImportedSession: vi.fn(async () => 'inserted' as const),
  insertParkedThoughtIfAbsent: vi.fn(async () => 'inserted' as const),
  insertProject: vi.fn(async () => {}),
  saveNote: vi.fn(async () => ({ note: null, cleanupPending: false })),
  updateSessionProject: vi.fn(async () => {}),
}));

vi.mock('./repository', () => ({
  insertImportedSession,
  insertParkedThoughtIfAbsent,
  insertProject,
  saveNote,
  updateSessionProject,
}));

const { applyImportedData } = await import('./importApply');

const NOW = 1_700_000_100_000;

function sessionEntry(overrides: Partial<ExportData['sessions'][number]> = {}): ExportData['sessions'][number] {
  return {
    id: 's1',
    task: 'Imported',
    completedAt: 1_700_000_000_000,
    plannedFocusMs: 1500_000,
    actualFocusMs: 1500_000,
    flowMs: 0,
    breakMs: 0,
    totalElapsedMs: 1500_000,
    parkedThoughtCount: 0,
    parkedThoughts: [],
    noteContent: null,
    projectName: null,
    categoryLabel: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertImportedSession.mockResolvedValue('inserted');
  insertParkedThoughtIfAbsent.mockResolvedValue('inserted');
});

describe('applyImportedData', () => {
  it('inserts every new session and counts it', async () => {
    const data: ExportData = { version: 4, exportedAt: NOW, sessions: [sessionEntry({ id: 's1' }), sessionEntry({ id: 's2' })], parkedThoughts: [] };
    const summary = await applyImportedData(data, [], NOW);
    expect(summary.sessionsImported).toBe(2);
    expect(summary.sessionsSkipped).toBe(0);
    expect(insertImportedSession).toHaveBeenCalledTimes(2);
  });

  it('counts a skipped (already-existing) session and never writes its note', async () => {
    insertImportedSession.mockResolvedValueOnce('skipped');
    const data: ExportData = {
      version: 4,
      exportedAt: NOW,
      sessions: [sessionEntry({ id: 's1', noteContent: 'should not be written' })],
      parkedThoughts: [],
    };
    const summary = await applyImportedData(data, [], NOW);
    expect(summary.sessionsSkipped).toBe(1);
    expect(summary.sessionsImported).toBe(0);
    expect(saveNote).not.toHaveBeenCalled();
  });

  it('writes a note only for a newly-inserted session with note content', async () => {
    const data: ExportData = {
      version: 4,
      exportedAt: NOW,
      sessions: [sessionEntry({ id: 's1', noteContent: 'A note' }), sessionEntry({ id: 's2', noteContent: null })],
      parkedThoughts: [],
    };
    await applyImportedData(data, [], NOW);
    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(saveNote).toHaveBeenCalledWith('s1', 'A note', NOW);
  });

  it('tags a newly-inserted session to a matching existing project without creating one', async () => {
    const existing: Project = { id: 'p1', name: 'Q3 Launch', category: 'work', archivedAt: null, createdAt: NOW };
    const data: ExportData = {
      version: 4,
      exportedAt: NOW,
      sessions: [sessionEntry({ id: 's1', projectName: 'Q3 Launch', categoryLabel: 'Work' })],
      parkedThoughts: [],
    };
    const summary = await applyImportedData(data, [existing], NOW);
    expect(summary.projectsCreated).toBe(0);
    expect(insertProject).not.toHaveBeenCalled();
    expect(updateSessionProject).toHaveBeenCalledWith('s1', 'p1');
  });

  it('creates a missing project, then tags the session to it', async () => {
    const data: ExportData = {
      version: 4,
      exportedAt: NOW,
      sessions: [sessionEntry({ id: 's1', projectName: 'New Project', categoryLabel: 'Study' })],
      parkedThoughts: [],
    };
    const summary = await applyImportedData(data, [], NOW);
    expect(summary.projectsCreated).toBe(1);
    expect(insertProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Project', category: 'study' }));
    const createdId = insertProject.mock.calls[0][0].id;
    expect(updateSessionProject).toHaveBeenCalledWith('s1', createdId);
  });

  it('reuses one newly-created project across multiple sessions in the same import', async () => {
    const data: ExportData = {
      version: 4,
      exportedAt: NOW,
      sessions: [
        sessionEntry({ id: 's1', projectName: 'New Project', categoryLabel: 'Study' }),
        sessionEntry({ id: 's2', projectName: 'New Project', categoryLabel: 'Study' }),
      ],
      parkedThoughts: [],
    };
    const summary = await applyImportedData(data, [], NOW);
    expect(summary.projectsCreated).toBe(1);
    expect(insertProject).toHaveBeenCalledTimes(1);
  });

  it('leaves an untagged session (no projectName) alone', async () => {
    const data: ExportData = { version: 4, exportedAt: NOW, sessions: [sessionEntry({ id: 's1' })], parkedThoughts: [] };
    await applyImportedData(data, [], NOW);
    expect(insertProject).not.toHaveBeenCalled();
    expect(updateSessionProject).not.toHaveBeenCalled();
  });

  it('inserts and counts parked thoughts independently of session outcomes', async () => {
    insertParkedThoughtIfAbsent.mockResolvedValueOnce('inserted').mockResolvedValueOnce('skipped');
    const data: ExportData = {
      version: 4,
      exportedAt: NOW,
      sessions: [],
      parkedThoughts: [
        { id: 't1', sessionId: 's1', text: 'One', createdAt: NOW },
        { id: 't2', text: 'Two', createdAt: NOW },
      ],
    };
    const summary = await applyImportedData(data, [], NOW);
    expect(summary.thoughtsImported).toBe(1);
    expect(summary.thoughtsSkipped).toBe(1);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/importApply.test.ts`
Expected: FAIL — `./importApply` doesn't exist yet.

- [ ] **Step 3: Implement `src/lib/importApply.ts`**

```ts
// Orchestrates merging a parsed ExportData into the live repository:
// skip-existing by id, auto-create missing projects, write notes only for
// newly-inserted sessions. Talks to ./repository directly (like App.svelte
// itself does) rather than taking dependencies by injection, so its own
// test file mocks ./repository the same way BreakdownChart.test.ts does.
// The caller (App.svelte) is responsible for wrapping the whole call in
// writeQueue.enqueue(...), matching every other repository mutation in
// this app — this module has no queue of its own.

import type { ExportData, SessionExportEntry } from './export';
import { insertImportedSession, insertParkedThoughtIfAbsent, insertProject, saveNote, updateSessionProject } from './repository';
import { CATEGORY_LABELS, type Project, type ProjectCategory } from './projects';

export interface ImportSummary {
  sessionsImported: number;
  sessionsSkipped: number;
  thoughtsImported: number;
  thoughtsSkipped: number;
  projectsCreated: number;
}

function categoryFromLabel(label: string): ProjectCategory | null {
  const match = (Object.entries(CATEGORY_LABELS) as [ProjectCategory, string][]).find(([, l]) => l === label);
  return match ? match[0] : null;
}

async function resolveProject(
  entry: SessionExportEntry,
  projects: Project[],
  now: number,
  summary: ImportSummary,
): Promise<string | null> {
  if (!entry.projectName || !entry.categoryLabel) return null;
  const category = categoryFromLabel(entry.categoryLabel);
  if (!category) return null;

  const existing = projects.find((p) => p.name === entry.projectName && p.category === category);
  if (existing) return existing.id;

  const created: Project = {
    id: crypto.randomUUID(),
    name: entry.projectName,
    category,
    archivedAt: null,
    createdAt: now,
  };
  await insertProject(created);
  projects.push(created);
  summary.projectsCreated += 1;
  return created.id;
}

export async function applyImportedData(data: ExportData, existingProjects: Project[], now: number): Promise<ImportSummary> {
  const summary: ImportSummary = {
    sessionsImported: 0,
    sessionsSkipped: 0,
    thoughtsImported: 0,
    thoughtsSkipped: 0,
    projectsCreated: 0,
  };
  const projects = [...existingProjects];

  for (const entry of data.sessions) {
    const outcome = await insertImportedSession(
      {
        id: entry.id,
        task: entry.task,
        completedAt: entry.completedAt,
        plannedFocusMs: entry.plannedFocusMs,
        actualFocusMs: entry.actualFocusMs,
        flowMs: entry.flowMs,
        breakMs: entry.breakMs,
        breakIntermissionMs: entry.breakIntermissionMs ?? 0,
        touchGrassMs: entry.touchGrassMs ?? 0,
        totalElapsedMs: entry.totalElapsedMs,
      },
      now,
    );

    if (outcome === 'skipped') {
      summary.sessionsSkipped += 1;
      continue;
    }
    summary.sessionsImported += 1;

    if (entry.noteContent) await saveNote(entry.id, entry.noteContent, now);

    const projectId = await resolveProject(entry, projects, now, summary);
    if (projectId) await updateSessionProject(entry.id, projectId);
  }

  for (const thought of data.parkedThoughts) {
    const outcome = await insertParkedThoughtIfAbsent({
      id: thought.id,
      sessionId: thought.sessionId,
      text: thought.text,
      createdAt: thought.createdAt,
    });
    if (outcome === 'inserted') summary.thoughtsImported += 1;
    else summary.thoughtsSkipped += 1;
  }

  return summary;
}
```

- [ ] **Step 4: Run tests, iterate until passing**

Run: `npx vitest run src/lib/importApply.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/importApply.ts src/lib/importApply.test.ts
git commit -m "feat: orchestrate merging imported data into the repository

applyImportedData skips existing sessions/thoughts by id, writes notes
only for newly-inserted sessions, and resolves each session's project by
name+category (auto-creating and reusing one across the same import when
no local match exists)."
```

---

### Task 5: `History.svelte` — Import button and file handling

**Files:**
- Modify: `src/lib/History.svelte`
- Test: `src/lib/HistoryImport.test.ts` (new — do not name this `History.test.ts`, see Global Constraints)

**Interfaces:**
- Consumes: `parseImportedMarkdown`, `parseImportedCsv`, `ImportParseResult` from `./import`; `ImportSummary` (type-only) from `./importApply`; adds a new required prop `onImport: (data: ExportData) => Promise<ImportSummary>` (type `ExportData` from `./export`).
- Produces: nothing new consumed elsewhere — this is the UI leaf. Task 6 wires the new `onImport` prop from `App.svelte`.

- [ ] **Step 1: Write failing component tests**

Create `src/lib/HistoryImport.test.ts`. Read `src/lib/HistoryTabs.test.ts` first for this file's existing default-props/render pattern for `History.svelte` and match it exactly (same required props, same `vi.mock` setup for `@tauri-apps/api/core`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs` if those aren't already mocked there — check `History.svelte`'s own existing export-flow tests, if any exist elsewhere, for the established mock pattern first, since `isTauri`/`save`/`writeTextFile` are already used by the existing Export buttons).

```ts
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import History from './History.svelte';

const { isTauri, open, readTextFile } = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  open: vi.fn(async () => null as string | null),
  readTextFile: vi.fn(async () => ''),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open, save: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile, writeTextFile: vi.fn(async () => {}) }));

function baseProps(overrides: Partial<Parameters<typeof History>[1]> = {}) {
  return {
    summaries: [],
    parkedThoughts: [],
    onBack: vi.fn(),
    onDeleteSession: vi.fn(),
    onDeleteAll: vi.fn(),
    onOpenNotesFolder: vi.fn(async () => {}),
    onViewRevisions: vi.fn(),
    projects: [],
    onAssignProject: vi.fn(async () => {}),
    onCreateProject: vi.fn(async () => ({ id: 'p1', name: 'x', category: 'work' as const, archivedAt: null, createdAt: 0 })),
    onImport: vi.fn(async () => ({ sessionsImported: 0, sessionsSkipped: 0, thoughtsImported: 0, thoughtsSkipped: 0, projectsCreated: 0 })),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  isTauri.mockReturnValue(true);
});

describe('History import', () => {
  it('shows an Import link next to the export links', () => {
    render(History, baseProps());
    expect(screen.getByText('Import')).toBeInTheDocument();
  });

  it('opens a file picker filtered to .md/.csv, reads the file, and calls onImport with the parsed data on success', async () => {
    open.mockResolvedValue('/tmp/heartwood-export.csv');
    readTextFile.mockResolvedValue(
      'Heartwood Export,4,2023-01-01T00:00:00.000Z\n\nSessions\nid,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category\n\nCurrently Parked Thoughts\nid,sessionId,text,createdAt\n',
    );
    const onImport = vi.fn(async () => ({ sessionsImported: 2, sessionsSkipped: 1, thoughtsImported: 0, thoughtsSkipped: 0, projectsCreated: 1 }));

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][0]).toMatchObject({ version: 4, sessions: [], parkedThoughts: [] });
    await screen.findByText(/Imported 2 sessions/);
    expect(screen.getByText(/1 new project/)).toBeInTheDocument();
  });

  it('does nothing when the file dialog is cancelled', async () => {
    open.mockResolvedValue(null);
    const onImport = vi.fn();
    render(History, baseProps({ onImport }));

    await fireEvent.click(screen.getByText('Import'));
    await Promise.resolve();

    expect(onImport).not.toHaveBeenCalled();
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it('shows a specific error and never calls onImport for a rejected (unparseable) file', async () => {
    open.mockResolvedValue('/tmp/old-export.csv');
    readTextFile.mockResolvedValue('not a heartwood export at all');
    const onImport = vi.fn();

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));

    await screen.findByRole('alert');
    expect(onImport).not.toHaveBeenCalled();
  });

  it('shows an error if onImport itself rejects', async () => {
    open.mockResolvedValue('/tmp/heartwood-export.csv');
    readTextFile.mockResolvedValue(
      'Heartwood Export,4,2023-01-01T00:00:00.000Z\n\nSessions\nid,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category\n\nCurrently Parked Thoughts\nid,sessionId,text,createdAt\n',
    );
    const onImport = vi.fn(async () => { throw new Error('boom'); });

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));

    await screen.findByRole('alert');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/lib/HistoryImport.test.ts`
Expected: FAIL — no `onImport` prop, no Import button yet. (Note: if `@tauri-apps/plugin-dialog`/`@tauri-apps/plugin-fs`/`@tauri-apps/api/core` are already mocked differently by an existing `History`-related test file's conventions, match that file's exact mock shape instead of the sketch above — the goal is passing tests using this codebase's established mocking style, not this exact snippet verbatim.)

- [ ] **Step 3: Add the `onImport` prop, state, and handlers to `History.svelte`**

Add to the imports at the top:

```ts
  import { open } from '@tauri-apps/plugin-dialog';
  import { readTextFile } from '@tauri-apps/plugin-fs';
  import { parseImportedCsv, parseImportedMarkdown } from './import';
  import type { ExportData } from './export';
  import type { ImportSummary } from './importApply';
```

(Combine with the existing `import { save } from '@tauri-apps/plugin-dialog';` and `import { writeTextFile } from '@tauri-apps/plugin-fs';` lines rather than duplicating the module specifiers — `import { save, open } from '@tauri-apps/plugin-dialog';` and `import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';`.)

Add `onImport` to the props destructure and its type:

```ts
    onCreateProject,
    onImport,
  }: {
    // ...existing fields...
    onCreateProject: (name: string, category: ProjectCategory) => Promise<Project>;
    onImport: (data: ExportData) => Promise<ImportSummary>;
  } = $props();
```

Add new state near `exportError`:

```ts
  let importStatus = $state<{ kind: 'success'; summary: ImportSummary } | { kind: 'error'; message: string } | null>(null);
  let importFileInput: HTMLInputElement | undefined = $state();
```

Add handler functions near `saveExport`/`exportMarkdown`/`exportCsv`:

```ts
  function importSummaryMessage(summary: ImportSummary): string {
    const skipped = summary.sessionsSkipped + summary.thoughtsSkipped;
    const parts = [`Imported ${summary.sessionsImported} sessions, ${summary.thoughtsImported} parked thoughts.`];
    if (skipped > 0) parts.push(`${skipped} already existed and were skipped.`);
    if (summary.projectsCreated > 0) {
      parts.push(`${summary.projectsCreated} new project${summary.projectsCreated === 1 ? '' : 's'} created.`);
    }
    return parts.join(' ');
  }

  async function handleImportContent(content: string, extension: 'md' | 'csv') {
    const result = extension === 'csv' ? parseImportedCsv(content) : parseImportedMarkdown(content);
    if (!result.ok) {
      importStatus = { kind: 'error', message: result.error };
      return;
    }
    try {
      const summary = await onImport(result.data);
      importStatus = { kind: 'success', summary };
    } catch (err) {
      console.error('Failed to import data:', err);
      importStatus = { kind: 'error', message: 'Failed to import data.' };
    }
  }

  async function importFile() {
    if (isTauri()) {
      const path = await open({ multiple: false, filters: [{ name: 'Heartwood Export', extensions: ['md', 'csv'] }] });
      if (!path) return; // user cancelled the dialog
      const content = await readTextFile(path);
      await handleImportContent(content, path.toLowerCase().endsWith('.csv') ? 'csv' : 'md');
    } else {
      importFileInput?.click();
    }
  }

  function handleBrowserImportFileSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      void handleImportContent(String(reader.result ?? ''), file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'md');
    };
    reader.readAsText(file);
  }
```

Add the Import button to the export row, and a status area, and the hidden browser-fallback file input. Replace:

```svelte
    <div class="export-row">
      <span class="export-label">Export</span>
      <button class="link" onclick={exportMarkdown}>Markdown</button>
      <button class="link" onclick={exportCsv}>CSV</button>
      <button
        type="button"
        class="link folder-link"
        onclick={handleOpenNotesFolder}
        title="Open notes folder"
      >
        <FolderOpen size={14} aria-hidden="true" />
        Notes folder
      </button>
    </div>
    {#if exportError}
      <p class="export-error" role="alert">{exportError}</p>
    {/if}
```

with:

```svelte
    <div class="export-row">
      <span class="export-label">Export</span>
      <button class="link" onclick={exportMarkdown}>Markdown</button>
      <button class="link" onclick={exportCsv}>CSV</button>
      <button
        type="button"
        class="link folder-link"
        onclick={handleOpenNotesFolder}
        title="Open notes folder"
      >
        <FolderOpen size={14} aria-hidden="true" />
        Notes folder
      </button>
      <span class="export-label">Import</span>
      <button class="link" onclick={importFile}>Import</button>
      <input
        type="file"
        accept=".md,.csv"
        bind:this={importFileInput}
        onchange={handleBrowserImportFileSelected}
        class="visually-hidden-input"
      />
    </div>
    {#if exportError}
      <p class="export-error" role="alert">{exportError}</p>
    {/if}
    {#if importStatus}
      <p class={importStatus.kind === 'error' ? 'export-error' : 'import-success'} role={importStatus.kind === 'error' ? 'alert' : 'status'}>
        {importStatus.kind === 'error' ? importStatus.message : importSummaryMessage(importStatus.summary)}
      </p>
    {/if}
```

Add CSS near `.export-error`:

```css
  .import-success {
    margin: -1rem 0 1.5rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .visually-hidden-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
```

- [ ] **Step 4: Run tests, iterate until passing**

Run: `npx vitest run src/lib/HistoryImport.test.ts`
Expected: PASS, all tests. Also re-run every other `History`-related test file (`history.test.ts`, `HistoryTabs.test.ts`, and any others found via `grep -rl "History.svelte" src/lib/*.test.ts`) to confirm the new required `onImport` prop didn't break their render calls — each will need `onImport: vi.fn(...)` added to its own render props if it renders `<History>` directly.

Run: `npx vitest run src/lib/history.test.ts src/lib/HistoryTabs.test.ts`
Expected: PASS. If any fail with a missing-prop TypeScript error or an "onImport is not a function" runtime error, add the same `onImport` stub used in Step 1 to that file's own render-props helper.

- [ ] **Step 5: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/History.svelte src/lib/HistoryImport.test.ts
git commit -m "feat: add Import button to History

Opens a native file picker (.md/.csv) in Tauri, falls back to a hidden
file input in browser-dev mode — mirroring the existing Export flow's
own Tauri/browser split. Parses the chosen file and hands the result to
the new onImport prop, showing either a success summary or a specific
error."
```

---

### Task 6: `App.svelte` — wire Import to the repository and refresh state

**Files:**
- Modify: `src/App.svelte`
- Test: `src/App.test.ts` (existing file — extend)

**Interfaces:**
- Consumes: `applyImportedData` from `./lib/importApply`; the existing `writeQueue`, `refreshHistorySummaries`, `refreshProjects`, `recoverParkedThoughts`, `projects` already in scope.
- Produces: passes `onImport={handleImportData}` to `<History>`.

- [ ] **Step 1: Write a failing test in `App.test.ts`**

`App.test.ts` does not mock `@tauri-apps/plugin-dialog`/`@tauri-apps/plugin-fs`/`@tauri-apps/api/core` anywhere — every existing export-flow test already runs against jsdom's real `isTauri()`, which resolves `false` there (no `window.__TAURI_INTERNALS__`), so History's existing Export buttons already exercise the browser-download branch in this file's tests, never the Tauri dialog branch. Follow that same convention: this test drives Import through its browser-fallback hidden `<input type="file">`, not the Tauri file picker (Task 5's own `HistoryImport.test.ts` already covers the Tauri dialog path in isolation with explicit mocks).

First add the two Task 3 functions to the shared `mocks` object (around line 178, next to `insertProject`) — every function `repository.ts` exports must have a stub here since `vi.mock('./lib/repository', () => mocks)` replaces the whole module with this object; without these two keys, `importApply.ts`'s `import { insertImportedSession, insertParkedThoughtIfAbsent } from './repository'` would resolve to `undefined`:

```ts
  insertImportedSession: vi.fn(async () => 'inserted' as const),
  insertParkedThoughtIfAbsent: vi.fn(async () => 'inserted' as const),
```

Follow the `fakeProjectStore` pattern already established in the `'Projects workspace refreshes after rename/archive'` describe block (search for `fakeProjectStore` in this file) — same idea, extended to fake session/parked-thought/project stores together so the test can assert a real refresh happened, not just that the mocks were called.

Add near that existing describe block:

```ts
describe('Import refreshes sessions/parked thoughts/projects afterward', () => {
  beforeEach(() => {
    mocks.loadLatestSessionRow.mockResolvedValue(null); // start idle so History is reachable without an active session
  });

  it('parses an imported file, applies it, and refreshes History/Projects with the result', async () => {
    let sessionRows: SessionRow[] = [];
    let thoughts: unknown[] = [];
    let projects: Project[] = [];

    mocks.loadCompletedSessions.mockImplementation(async () => sessionRows);
    mocks.loadAllParkedThoughts.mockImplementation(async () => thoughts);
    mocks.loadAllProjects.mockImplementation(async () => projects);
    mocks.insertImportedSession.mockImplementation(async (entry: { id: string; task: string; completedAt: number }) => {
      if (sessionRows.some((r) => r.id === entry.id)) return 'skipped' as const;
      sessionRows = [
        ...sessionRows,
        completeSessionRow({
          id: entry.id,
          task: entry.task,
          completed_at: entry.completedAt,
          review_acknowledged_at: entry.completedAt,
        }),
      ];
      return 'inserted' as const;
    });
    mocks.insertParkedThoughtIfAbsent.mockImplementation(async (thought: { id: string }) => {
      if (thoughts.some((t: any) => t.id === thought.id)) return 'skipped' as const;
      thoughts = [...thoughts, thought];
      return 'inserted' as const;
    });
    mocks.insertProject.mockImplementation(async (project: Project) => {
      projects = [...projects, project];
    });

    const { container } = render(App);
    await screen.findByRole('textbox', { name: 'Focus task' });

    await fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await screen.findByText('Session history');

    const csv = [
      'Heartwood Export,4,2023-01-01T00:00:00.000Z',
      '',
      'Sessions',
      'id,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category',
      's1,Imported task,2023-01-01T00:00:00.000Z,1500000,1500000,0,0,0,0,1500000,0,,,New Project,Work',
      '',
      'Currently Parked Thoughts',
      'id,sessionId,text,createdAt',
      't1,,Imported thought,2023-01-01T00:00:00.000Z',
    ].join('\n');

    await fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([csv], 'export.csv', { type: 'text/csv' });
    await fireEvent.change(fileInput, { target: { files: [file] } });

    await screen.findByText(/Imported 1 sessions, 1 parked thoughts/);
    expect(mocks.insertImportedSession).toHaveBeenCalledTimes(1);
    expect(mocks.insertProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Project', category: 'work' }));
    expect(mocks.updateSessionProject).toHaveBeenCalledWith('s1', expect.any(String));
    // The refresh, not just the write: History shows the newly-imported
    // session without any unrelated trigger.
    expect(screen.getByText('Imported task')).toBeTruthy();
  });
});
```

This reuses `completeSessionRow(...)` — the file's own existing row-builder helper (defined above `mocks`, used throughout the file already) and `Project`, already imported at the top of the file (`import type { Project } from './lib/projects';`).

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/App.test.ts`
Expected: FAIL — no `onImport` wiring yet, so `<History>` render fails on a missing required prop (or the new test's assertions fail).

- [ ] **Step 3: Implement `handleImportData` in `App.svelte`**

Add the import near the other `./lib/...` imports:

```ts
  import { applyImportedData } from './lib/importApply';
  import type { ExportData } from './lib/export';
```

Add the handler near `handleCreateProject`/`refreshProjects` (same section):

```ts
  /** Runs the whole import as one queued task (writeQueue is FIFO, so this
   * serializes correctly against any other in-flight repository write the
   * same way every other mutation in this file already does), then
   * refreshes every piece of state import can touch. parkedThoughts must
   * be refreshed before refreshHistorySummaries(), since that function
   * reads the outer-scope parkedThoughts variable synchronously to build
   * each summary's parked-thought count. */
  async function handleImportData(data: ExportData): Promise<ImportSummary> {
    const summary = await writeQueue.enqueue(() => applyImportedData(data, projects, Date.now()));
    await recoverParkedThoughts();
    await Promise.all([refreshHistorySummaries(), refreshProjects()]);
    return summary;
  }
```

Add the matching type import: `import type { ImportSummary } from './lib/importApply';` (combine with the `applyImportedData` import line above: `import { applyImportedData, type ImportSummary } from './lib/importApply';`).

Wire the prop onto `<History>`:

```svelte
      <History
        summaries={historySummaries}
        parkedThoughts={parkedThoughts}
        onBack={handleBackFromHistory}
        onDeleteSession={handleDeleteSessionFromHistory}
        onDeleteAll={handleDeleteAllData}
        onOpenNotesFolder={openNotesFolder}
        onViewRevisions={handleViewRevisions}
        projects={projects}
        onAssignProject={async (sessionId, projectId) => {
          await updateSessionProject(sessionId, projectId);
          await refreshHistorySummaries();
        }}
        onCreateProject={handleCreateProject}
        onImport={handleImportData}
      />
```

- [ ] **Step 4: Run tests, iterate until passing**

Run: `npx vitest run src/App.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full check and suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/App.svelte src/App.test.ts
git commit -m "feat: wire Import through App.svelte to the repository

handleImportData runs the whole import as one writeQueue-serialized task,
then refreshes parked thoughts, history summaries, and projects so newly
imported data appears immediately without a manual reload."
```

---

## Final Verification (after all tasks)

- [ ] Run `npm run check && npx vitest run` once more from a clean tree; confirm 0 errors and every test passes.
- [ ] Manual Tauri check (`npm run tauri:dev` or a debug build via `npm run tauri:build -- --debug`): export real session data as both Markdown and CSV, then import each back in — confirm sessions, parked thoughts, notes, and project tags all land correctly, re-importing the same file a second time is a no-op (all-skipped summary), and importing a file with an old/missing version marker shows a clear error.
