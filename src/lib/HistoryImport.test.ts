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
    expect(screen.getByText('Import')).toBeTruthy();
  });

  it('opens a file picker filtered to .md/.csv, reads the file, and calls onImport with the parsed data on success', async () => {
    open.mockResolvedValue('/tmp/heartwood-export.csv');
    readTextFile.mockResolvedValue(
      'Heartwood Export,4,2023-01-01T00:00:00.000Z\n\nSessions\nid,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category\n\nCurrently Parked Thoughts\nid,sessionId,text,createdAt\n',
    );
    const onImport = vi.fn(async (_data: ExportData) => ({ sessionsImported: 2, sessionsSkipped: 1, thoughtsImported: 0, thoughtsSkipped: 0, projectsCreated: 1 }));

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
    readTextFile.mockResolvedValue(
      'Heartwood Export,4,2023-01-01T00:00:00.000Z\n\nSessions\nid,task,completedAt,plannedFocusMs,actualFocusMs,flowMs,breakMs,breakIntermissionMs,touchGrassMs,totalElapsedMs,parkedThoughtCount,parkedThoughts,noteContent,project,category\n\nCurrently Parked Thoughts\nid,sessionId,text,createdAt\n',
    );
    const onImport = vi.fn(async () => { throw new Error('boom'); });

    render(History, baseProps({ onImport }));
    await fireEvent.click(screen.getByText('Import'));

    await screen.findByRole('alert');
  });
});
