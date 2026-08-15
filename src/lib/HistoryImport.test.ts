// @vitest-environment jsdom
//
// Named HistoryImport, not History: this filesystem is case-insensitive, and
// `history.test.ts` (the pure-logic test for history.ts) already exists —
// `History.test.ts` would silently collide with it. See HistoryTabs.test.ts
// for the same naming workaround elsewhere in this codebase.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import History from './History.svelte';
import type { ExportData } from './export';
import type { ImportSummary } from './importApply';

const { isTauri, open, readTextFile } = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  open: vi.fn(async () => null as string | null),
  readTextFile: vi.fn(async () => ''),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open, save: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile, writeTextFile: vi.fn(async () => {}) }));

function emptySummary(overrides: Partial<ImportSummary> = {}): ImportSummary {
  return {
    sessionsImported: 0,
    sessionsSkipped: 0,
    sessionsFailed: 0,
    thoughtsImported: 0,
    thoughtsSkipped: 0,
    thoughtsFailed: 0,
    projectsCreated: 0,
    ...overrides,
  };
}

const VALID_CSV =
  'Heartwood Export,4,2023-01-01T00:00:00.000Z\n\nSessions\nid,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category\n\nCurrently Parked Thoughts\nid,sessionId,text,createdAt\n';

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
    onImport: vi.fn(async () => emptySummary()),
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
    expect(screen.getByText('Import')).toBeTruthy();
  });

  it('opens a file picker filtered to .md/.csv, reads the file, and calls onImport with the parsed data on success', async () => {
    open.mockResolvedValue('/tmp/heartwood-export.csv');
    readTextFile.mockResolvedValue(VALID_CSV);
    const onImport = vi.fn(async (_data: ExportData) =>
      emptySummary({ sessionsImported: 2, sessionsSkipped: 1, projectsCreated: 1 }),
    );

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][0]).toMatchObject({ version: 4, sessions: [], parkedThoughts: [] });
    await screen.findByText(/Imported 2 sessions/);
    expect(screen.getByText(/1 new project/)).toBeTruthy();
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
    readTextFile.mockResolvedValue(VALID_CSV);
    const onImport = vi.fn(async () => { throw new Error('boom'); });

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));

    await screen.findByRole('alert');
  });

  it('shows an error when the file cannot be read', async () => {
    open.mockResolvedValue('/tmp/heartwood-export.csv');
    readTextFile.mockRejectedValue(new Error('EACCES'));
    const onImport = vi.fn();

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));

    expect((await screen.findByRole('alert')).textContent).toMatch(/failed to read/i);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('shows an error when the file dialog itself fails', async () => {
    open.mockRejectedValue(new Error('dialog unavailable'));
    const onImport = vi.fn();

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));

    expect((await screen.findByRole('alert')).textContent).toMatch(/failed to read/i);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('shows an error when the browser-fallback FileReader fails', async () => {
    isTauri.mockReturnValue(false);
    // jsdom's FileReader will happily read any Blob, so the failure has to
    // be induced: fire the error event the real reader would fire.
    const readAsText = vi
      .spyOn(FileReader.prototype, 'readAsText')
      .mockImplementation(function (this: FileReader) {
        this.dispatchEvent(new Event('error'));
      });
    const onImport = vi.fn();

    const { container } = render(History, baseProps({ onImport }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['whatever'], 'export.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await fireEvent.change(input);

    expect((await screen.findByRole('alert')).textContent).toMatch(/failed to read/i);
    expect(onImport).not.toHaveBeenCalled();
    readAsText.mockRestore();
  });

  it('clears the previous attempt\'s message when a new import starts', async () => {
    open.mockResolvedValue('/tmp/old-export.csv');
    readTextFile.mockResolvedValue('not a heartwood export at all');

    render(History, baseProps());
    await fireEvent.click(screen.getByText('Import'));
    await screen.findByRole('alert');

    // A cancelled second attempt must not leave the first attempt's error
    // sitting on screen as though it described this run.
    open.mockResolvedValue(null);
    await fireEvent.click(screen.getByText('Import'));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('clears a previous success message when a new import starts', async () => {
    open.mockResolvedValue('/tmp/heartwood-export.csv');
    readTextFile.mockResolvedValue(VALID_CSV);
    const onImport = vi.fn(async (_data: ExportData) => emptySummary({ sessionsImported: 2 }));

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));
    await screen.findByText(/Imported 2 sessions/);

    open.mockResolvedValue(null);
    await fireEvent.click(screen.getByText('Import'));

    await waitFor(() => expect(screen.queryByText(/Imported 2 sessions/)).toBeNull());
  });

  it('reports contained failures in the success summary', async () => {
    open.mockResolvedValue('/tmp/heartwood-export.csv');
    readTextFile.mockResolvedValue(VALID_CSV);
    const onImport = vi.fn(async (_data: ExportData) =>
      emptySummary({ sessionsImported: 1, sessionsFailed: 2, thoughtsFailed: 3 }),
    );

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));

    await screen.findByText(/2 sessions and 3 thoughts could not be imported\./);
  });
});
