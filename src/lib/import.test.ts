import { describe, expect, it } from 'vitest';
import { buildExportData, formatExportAsCsv, formatExportAsMarkdown } from './export';
import {
  CORRUPTED_ERROR,
  NOT_AN_EXPORT_ERROR,
  UNSUPPORTED_VERSION_ERROR,
  parseImportedCsv,
  parseImportedMarkdown,
} from './import';
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

const CSV_SESSION_HEADER =
  'id,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category';

/** One well-formed v4 session row, with any single cell overridden to
 * whatever raw text a test wants to feed the parser. */
function sessionRow(overrides: Record<string, string> = {}): string {
  const cells: Record<string, string> = {
    id: 's1',
    task: 'test',
    completedAt: '2023-01-01T00:00:00.000Z',
    plannedFocusMs: '1500000',
    actualFocusMs: '1500000',
    flowMs: '0',
    breakMs: '0',
    breakIntermissionMs: '0',
    touchGrassMs: '0',
    totalElapsedMs: '1500000',
    parkedThoughtCount: '0',
    parkedThoughts: '',
    noteContent: '',
    project: '',
    category: '',
    ...overrides,
  };
  return CSV_SESSION_HEADER.split(',')
    .map((column) => cells[column])
    .join(',');
}

function csvWithSessionRow(row: string): string {
  return [
    'Heartwood Export,4,2023-01-01T00:00:00.000Z',
    '',
    'Sessions',
    CSV_SESSION_HEADER,
    row,
    '',
    'Currently Parked Thoughts',
    'id,sessionId,text,createdAt',
    '',
  ].join('\n');
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

  it('rejects a realistic pre-v4 Markdown export as an older version, not as a non-export', () => {
    // What formatExportAsMarkdown actually produced before v4: the heading
    // and prose, with no hidden data block anywhere.
    const preV4 = [
      '# Heartwood Export',
      '',
      '_Exported Jan 1, 2023, 12:00 AM_',
      '',
      '## Sessions',
      '',
      '### Write the report',
      '',
      '- Completed: Jan 1, 2023, 12:00 AM',
      '- Focus: 25m of 25m planned',
      '',
      '## Currently Parked Thoughts',
      '',
      '- Check on the deploy',
      '',
    ].join('\n');
    const result = parseImportedMarkdown(preV4);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(UNSUPPORTED_VERSION_ERROR);
  });

  it('still rejects a file that was never a Heartwood export as a non-export', () => {
    const result = parseImportedMarkdown('# Shopping list\n\n- milk\n- eggs\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(NOT_AN_EXPORT_ERROR);
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

  it('rejects a hidden block with valid top-level shape but a session entry missing id', () => {
    const malformedData = { version: 4, exportedAt: T0, sessions: [{ task: 'test', completedAt: T0, plannedFocusMs: 1500000, actualFocusMs: 1500000, flowMs: 0, breakMs: 0, totalElapsedMs: 1500000, parkedThoughtCount: 0, parkedThoughts: [], noteContent: null, projectName: null, categoryLabel: null }], parkedThoughts: [] };
    const b64 = btoa(JSON.stringify(malformedData));
    const result = parseImportedMarkdown(`<!-- heartwood-export-data:${b64} -->\n\n# Heartwood Export`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("This export file is corrupted and couldn't be read.");
  });

  it('rejects a hidden block with valid top-level shape but a session entry with completedAt as string', () => {
    const malformedData = { version: 4, exportedAt: T0, sessions: [{ id: 's1', task: 'test', completedAt: 'not-a-number', plannedFocusMs: 1500000, actualFocusMs: 1500000, flowMs: 0, breakMs: 0, totalElapsedMs: 1500000, parkedThoughtCount: 0, parkedThoughts: [], noteContent: null, projectName: null, categoryLabel: null }], parkedThoughts: [] };
    const b64 = btoa(JSON.stringify(malformedData));
    const result = parseImportedMarkdown(`<!-- heartwood-export-data:${b64} -->\n\n# Heartwood Export`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("This export file is corrupted and couldn't be read.");
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

  it('rejects a realistic pre-v4 CSV export as an older version, not as a non-export', () => {
    // What formatExportAsCsv actually produced before v4: no version marker
    // line at all, the Sessions section first, dates locale-formatted.
    const preV4 = [
      'Sessions',
      'id,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category',
      's1,Write the report,"Jan 1, 2023, 12:00 AM",1500000,1500000,0,0,0,0,1500000,0,,,,',
      '',
      'Currently Parked Thoughts',
      'id,sessionId,text,createdAt',
      '',
    ].join('\n');
    const result = parseImportedCsv(preV4);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(UNSUPPORTED_VERSION_ERROR);
  });

  it('still rejects a CSV that was never a Heartwood export as a non-export', () => {
    const result = parseImportedCsv('name,quantity\nmilk,1\neggs,12\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(NOT_AN_EXPORT_ERROR);
  });

  it('rejects a CSV with a non-finite value in a numeric column', () => {
    const result = parseImportedCsv(csvWithSessionRow(sessionRow({ plannedFocusMs: 'Infinity' })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(CORRUPTED_ERROR);
  });

  it('rejects a CSV with an empty numeric cell instead of silently reading it as 0', () => {
    const result = parseImportedCsv(csvWithSessionRow(sessionRow({ totalElapsedMs: '' })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(CORRUPTED_ERROR);
  });

  it('rejects a CSV with non-numeric value in a numeric column', () => {
    const result = parseImportedCsv(
      'Heartwood Export,4,2023-01-01T00:00:00.000Z\n\nSessions\nid,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category\ns1,test,2023-01-01T00:00:00.000Z,not-a-number,1500000,0,0,0,0,1500000,0,,null,,\n\nCurrently Parked Thoughts\nid,sessionId,text,createdAt\n',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("This export file is corrupted and couldn't be read.");
  });
});
