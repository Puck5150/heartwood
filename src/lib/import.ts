// Pure parsers that reverse export.ts's formatExportAsCsv/formatExportAsMarkdown
// back into an ExportData object. No DOM, no repository access — matches
// export.ts's own separation of concerns. Never throws: every failure path
// returns { ok: false, error } with a message meant to be shown directly
// to the user.

import { EXPORT_FORMAT_VERSION, type ExportData, type ParkedThoughtExportEntry, type SessionExportEntry } from './export';

export type ImportParseResult = { ok: true; data: ExportData } | { ok: false; error: string };

const UNSUPPORTED_VERSION_ERROR =
  "This file was exported by an older version of Heartwood and can't be imported. Re-export it from that version's History screen, then try again.";
const NOT_AN_EXPORT_ERROR = "This is not a Heartwood export file.";
const CORRUPTED_ERROR = "This export file is corrupted and couldn't be read.";

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
