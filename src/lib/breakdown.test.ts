import { describe, expect, it } from 'vitest';
import {
  describeArcPath,
  filterSummariesByRange,
  groupByCategory,
  groupByProjectInCategory,
  toChartSegments,
} from './breakdown';
import type { Project } from './projects';
import type { SessionSummary } from './history';

const T0 = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'default-id',
    task: 'Task',
    completedAt: T0,
    plannedFocusMs: 0,
    actualFocusMs: 0,
    flowMs: 0,
    tookBreak: false,
    breakMs: 0,
    breakIntermissionMs: 0,
    touchGrassMs: 0,
    totalElapsedMs: 0,
    parkedThoughtCount: 0,
    noteContent: null,
    revisionCount: 0,
    projectId: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project>): Project {
  return {
    id: 'default-project',
    name: 'Project',
    category: 'work',
    archivedAt: null,
    createdAt: T0,
    ...overrides,
  };
}

describe('filterSummariesByRange', () => {
  const summaries = [
    summary({ id: 's1', completedAt: T0 }),
    summary({ id: 's2', completedAt: T0 - 3 * DAY_MS }),
    summary({ id: 's3', completedAt: T0 - 10 * DAY_MS }),
    summary({ id: 's4', completedAt: T0 - 40 * DAY_MS }),
  ];

  it('week keeps only the last 7 days', () => {
    const result = filterSummariesByRange(summaries, 'week', T0);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('month keeps only the last 30 days', () => {
    const result = filterSummariesByRange(summaries, 'month', T0);
    expect(result.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('all returns everything unfiltered', () => {
    expect(filterSummariesByRange(summaries, 'all', T0)).toEqual(summaries);
  });
});

describe('groupByCategory', () => {
  it('buckets sessions by their project\'s category, and untagged sessions separately', () => {
    const projectsById = new Map([
      ['p-work', project({ id: 'p-work', category: 'work' })],
      ['p-study', project({ id: 'p-study', category: 'study' })],
    ]);
    const summaries = [
      summary({ id: 's1', projectId: 'p-work', actualFocusMs: 1000 }),
      summary({ id: 's2', projectId: 'p-work', actualFocusMs: 500 }),
      summary({ id: 's3', projectId: 'p-study', actualFocusMs: 2000 }),
      summary({ id: 's4', projectId: null, actualFocusMs: 300 }),
    ];

    const totals = groupByCategory(summaries, projectsById);
    expect(totals).toEqual([
      { key: 'personal', label: 'Personal', totalMs: 0 },
      { key: 'work', label: 'Work', totalMs: 1500 },
      { key: 'study', label: 'Study', totalMs: 2000 },
      { key: 'untagged', label: 'Untagged', totalMs: 300 },
    ]);
  });

  it('a project_id that no longer resolves to a project counts as untagged', () => {
    const summaries = [summary({ id: 's1', projectId: 'deleted-project', actualFocusMs: 100 })];
    const totals = groupByCategory(summaries, new Map());
    expect(totals.find((t) => t.key === 'untagged')?.totalMs).toBe(100);
  });
});

describe('groupByProjectInCategory', () => {
  it('only includes projects in the requested category, sorted by total descending', () => {
    const projectsById = new Map([
      ['p1', project({ id: 'p1', name: 'Alpha', category: 'work' })],
      ['p2', project({ id: 'p2', name: 'Beta', category: 'work' })],
      ['p3', project({ id: 'p3', name: 'Gamma', category: 'study' })],
    ]);
    const summaries = [
      summary({ id: 's1', projectId: 'p1', actualFocusMs: 100 }),
      summary({ id: 's2', projectId: 'p2', actualFocusMs: 500 }),
      summary({ id: 's3', projectId: 'p3', actualFocusMs: 900 }),
    ];

    const result = groupByProjectInCategory(summaries, projectsById, 'work');
    expect(result).toEqual([
      { projectId: 'p2', label: 'Beta', totalMs: 500 },
      { projectId: 'p1', label: 'Alpha', totalMs: 100 },
    ]);
  });

  it('excludes projects with zero total in the requested category', () => {
    const projectsById = new Map([
      ['p1', project({ id: 'p1', name: 'Alpha', category: 'work' })],
      ['p2', project({ id: 'p2', name: 'Beta', category: 'work' })],
    ]);
    const summaries = [
      summary({ id: 's1', projectId: 'p1', actualFocusMs: 100 }),
      summary({ id: 's2', projectId: 'p2', actualFocusMs: 0 }),
    ];

    const result = groupByProjectInCategory(summaries, projectsById, 'work');
    expect(result).toEqual([{ projectId: 'p1', label: 'Alpha', totalMs: 100 }]);
    expect(result.find((p) => p.projectId === 'p2')).toBeUndefined();
  });
});

describe('toChartSegments', () => {
  it('computes cumulative percent and angle ranges', () => {
    const segments = toChartSegments([
      { label: 'A', totalMs: 300 },
      { label: 'B', totalMs: 100 },
    ]);
    expect(segments[0]).toEqual({ label: 'A', totalMs: 300, percent: 75, startAngle: 0, endAngle: 270 });
    expect(segments[1]).toEqual({ label: 'B', totalMs: 100, percent: 25, startAngle: 270, endAngle: 360 });
  });

  it('returns all-zero segments for an empty total rather than dividing by zero', () => {
    const segments = toChartSegments([{ label: 'A', totalMs: 0 }]);
    expect(segments[0].percent).toBe(0);
    expect(Number.isFinite(segments[0].startAngle)).toBe(true);
  });
});

describe('describeArcPath', () => {
  it('returns a valid SVG path string for a quarter circle', () => {
    const d = describeArcPath(50, 50, 40, 0, 90);
    expect(d).toMatch(/^M 50 50 L/);
    expect(d).toContain('A 40 40 0 0 0');
  });

  it('does not degenerate for a full 360-degree sweep', () => {
    const d = describeArcPath(50, 50, 40, 0, 360);
    expect(d.length).toBeGreaterThan(0);
    expect(d).not.toContain('NaN');
  });
});
