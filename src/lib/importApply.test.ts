import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportData } from './export';
import type { Project } from './projects';
import type { ImportOutcome } from './persistence';

const {
  insertImportedSession,
  insertParkedThoughtIfAbsent,
  insertProject,
  saveNote,
  updateSessionProject,
} = vi.hoisted(() => ({
  insertImportedSession: vi.fn(async (): Promise<ImportOutcome> => 'inserted'),
  insertParkedThoughtIfAbsent: vi.fn(async (): Promise<ImportOutcome> => 'inserted'),
  insertProject: vi.fn(async (_project: Project) => {}),
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
