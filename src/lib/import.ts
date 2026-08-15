// Pure parsers that reverse export.ts's formatExportAsCsv/formatExportAsMarkdown
// back into an ExportData object. No DOM, no repository access — matches
// export.ts's own separation of concerns. Never throws: every failure path
// returns { ok: false, error } with a message meant to be shown directly
// to the user.

import { EXPORT_FORMAT_VERSION, type ExportData, type ParkedThoughtExportEntry, type SessionExportEntry } from './export';

export type ImportParseResult = { ok: true; data: ExportData } | { ok: false; error: string };

// Exported so the tests can assert which of the three a given input maps to
// by identity rather than by re-typing (and drifting from) the copy.
export const UNSUPPORTED_VERSION_ERROR =
  "This file was exported by an older version of Heartwood and can't be imported. Re-export it from that version's History screen, then try again.";
export const NOT_AN_EXPORT_ERROR = "This is not a Heartwood export file.";
export const CORRUPTED_ERROR = "This export file is corrupted and couldn't be read.";

function decodeBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isValidExportData(value: unknown): value is ExportData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;

  // Check top-level shape
  if (typeof v.version !== 'number' ||
      typeof v.exportedAt !== 'number' ||
      !Array.isArray(v.sessions) ||
      !Array.isArray(v.parkedThoughts)) {
    return false;
  }

  // Validate each session entry
  for (const session of v.sessions) {
    if (typeof session !== 'object' || session === null) return false;
    const s = session as Record<string, unknown>;
    if (typeof s.id !== 'string' ||
        typeof s.task !== 'string' ||
        typeof s.completedAt !== 'number' ||
        !Number.isFinite(s.completedAt) ||
        typeof s.plannedFocusMs !== 'number' ||
        !Number.isFinite(s.plannedFocusMs) ||
        typeof s.actualFocusMs !== 'number' ||
        !Number.isFinite(s.actualFocusMs) ||
        typeof s.flowMs !== 'number' ||
        !Number.isFinite(s.flowMs) ||
        typeof s.breakMs !== 'number' ||
        !Number.isFinite(s.breakMs) ||
        typeof s.totalElapsedMs !== 'number' ||
        !Number.isFinite(s.totalElapsedMs) ||
        typeof s.parkedThoughtCount !== 'number' ||
        !Number.isFinite(s.parkedThoughtCount) ||
        !Array.isArray(s.parkedThoughts) ||
        !s.parkedThoughts.every((t: unknown) => typeof t === 'string') ||
        (s.noteContent !== null && typeof s.noteContent !== 'string') ||
        (s.projectName !== null && typeof s.projectName !== 'string') ||
        (s.categoryLabel !== null && typeof s.categoryLabel !== 'string')) {
      return false;
    }
    // Optional fields
    if ('breakIntermissionMs' in s && (typeof s.breakIntermissionMs !== 'number' || !Number.isFinite(s.breakIntermissionMs))) {
      return false;
    }
    if ('touchGrassMs' in s && (typeof s.touchGrassMs !== 'number' || !Number.isFinite(s.touchGrassMs))) {
      return false;
    }
  }

  // Validate each parked thought entry
  for (const thought of v.parkedThoughts) {
    if (typeof thought !== 'object' || thought === null) return false;
    const t = thought as Record<string, unknown>;
    if (typeof t.id !== 'string' ||
        typeof t.text !== 'string' ||
        typeof t.createdAt !== 'number' ||
        !Number.isFinite(t.createdAt)) {
      return false;
    }
    if ('sessionId' in t && typeof t.sessionId !== 'string') {
      return false;
    }
  }

  return true;
}

const HIDDEN_BLOCK_RE = /^<!-- heartwood-export-data:([A-Za-z0-9+/=]+) -->/;

/** Present in every version of formatExportAsMarkdown's output, v3 and v4
 * alike. The hidden data block only exists from v4 on, so this heading is
 * the only thing that distinguishes a genuine pre-v4 export (which deserves
 * the "older version" message) from a file that was never a Heartwood
 * export at all. */
const MARKDOWN_HEADING = '# Heartwood Export';

export function parseImportedMarkdown(content: string): ImportParseResult {
  const match = content.match(HIDDEN_BLOCK_RE);
  if (!match) {
    return { ok: false, error: content.includes(MARKDOWN_HEADING) ? UNSUPPORTED_VERSION_ERROR : NOT_AN_EXPORT_ERROR };
  }

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

/** Number.isFinite, not just !Number.isNaN — matching isValidExportData's
 * standard exactly, so a literal `Infinity` in a numeric column can't slip
 * through the CSV path when the Markdown path would reject it. The empty
 * check is separate because `Number('')` is 0, which is finite: every
 * numeric column formatExportAsCsv writes is always a real number (`?? 0`
 * for the optional ones), so a blank cell means a damaged file, not a zero. */
function parseRequiredNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function parseImportedCsv(content: string): ImportParseResult {
  // Blank physical lines are section separators here, never data — a blank
  // line can never occur inside a quoted field without also being inside
  // an open quote (which parseCsvRows already keeps intact), so filtering
  // single-empty-field rows can't accidentally drop a real record.
  const rows = parseCsvRows(content).filter((r) => !(r.length === 1 && r[0] === ''));

  const versionRow = rows[0];
  if (!versionRow || versionRow[0] !== 'Heartwood Export') {
    // A pre-v4 CSV has no version marker at all — its very first row is the
    // `Sessions` section header. That's the only signal separating a real
    // old export from a file that was never a Heartwood export.
    return { ok: false, error: versionRow?.[0] === 'Sessions' ? UNSUPPORTED_VERSION_ERROR : NOT_AN_EXPORT_ERROR };
  }
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
    const plannedFocusMs = parseRequiredNumber(r[3]);
    if (plannedFocusMs === null) return { ok: false, error: CORRUPTED_ERROR };
    const actualFocusMs = parseRequiredNumber(r[4]);
    if (actualFocusMs === null) return { ok: false, error: CORRUPTED_ERROR };
    const flowMs = parseRequiredNumber(r[5]);
    if (flowMs === null) return { ok: false, error: CORRUPTED_ERROR };
    const breakMs = parseRequiredNumber(r[6]);
    if (breakMs === null) return { ok: false, error: CORRUPTED_ERROR };
    const breakIntermissionMs = parseRequiredNumber(r[7]);
    if (breakIntermissionMs === null) return { ok: false, error: CORRUPTED_ERROR };
    const touchGrassMs = parseRequiredNumber(r[8]);
    if (touchGrassMs === null) return { ok: false, error: CORRUPTED_ERROR };
    const totalElapsedMs = parseRequiredNumber(r[9]);
    if (totalElapsedMs === null) return { ok: false, error: CORRUPTED_ERROR };
    const parkedThoughtCount = parseRequiredNumber(r[10]);
    if (parkedThoughtCount === null) return { ok: false, error: CORRUPTED_ERROR };
    sessions.push({
      id: r[0],
      task: r[1],
      completedAt,
      plannedFocusMs,
      actualFocusMs,
      flowMs,
      breakMs,
      ...(breakIntermissionMs > 0 ? { breakIntermissionMs } : {}),
      ...(touchGrassMs > 0 ? { touchGrassMs } : {}),
      totalElapsedMs,
      parkedThoughtCount,
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

  // Both parsers terminate through the same gate rather than each keeping
  // its own drifting notion of "valid" — the column-by-column checks above
  // are about CSV shape, this is about the ExportData contract itself.
  const data = { version: EXPORT_FORMAT_VERSION, exportedAt, sessions, parkedThoughts };
  if (!isValidExportData(data)) return { ok: false, error: CORRUPTED_ERROR };
  return { ok: true, data };
}
