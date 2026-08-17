import { describe, expect, it } from 'vitest';
import { buildExportData, EXPORT_FORMAT_VERSION, formatExportAsCsv, formatExportAsMarkdown } from './export';
import type { SessionSummary } from './history';
import type { ParkedThought } from './parkingLot';
import type { Project } from './projects';
import type { Task } from './tasks';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    task: 'Write the report',
    completedAt: 1_700_000_000_000,
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
  return {
    id: 't1',
    sessionId: 's1',
    text: 'Check on the deploy',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task1',
    projectId: 'p1',
    title: 'Write the outline',
    notes: null,
    status: 'backlog',
    priority: 'medium',
    dueAt: null,
    position: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('buildExportData', () => {
  it('produces an empty payload for no sessions and no parked thoughts', () => {
    const data = buildExportData([], [], 1_700_000_100_000);
    expect(data).toEqual({
      version: EXPORT_FORMAT_VERSION,
      exportedAt: 1_700_000_100_000,
      sessions: [],
      parkedThoughts: [],
      tasks: [],
    });
  });

  it('embeds only the text of thoughts tagged with a session into that session entry', () => {
    const thoughts = [
      thought({ id: 't1', sessionId: 's1', text: 'For session 1' }),
      thought({ id: 't2', sessionId: 's2', text: 'For session 2' }),
    ];
    const data = buildExportData([summary({ id: 's1', parkedThoughtCount: 1 })], thoughts, 1_700_000_100_000);

    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].parkedThoughts).toEqual(['For session 1']);
  });

  it('includes a thought not tied to any visible session summary in the top-level list (not lost)', () => {
    // Simulates a thought parked during a still-active session, or one
    // whose original session was deleted — neither has a history row.
    const orphan = thought({ id: 't1', sessionId: 'no-such-session', text: 'Orphaned thought' });
    const data = buildExportData([summary({ id: 's1' })], [orphan], 1_700_000_100_000);

    expect(data.sessions[0].parkedThoughts).toEqual([]);
    expect(data.parkedThoughts).toEqual([
      { id: 't1', sessionId: 'no-such-session', text: 'Orphaned thought', createdAt: 1_700_000_000_000 },
    ]);
  });

  it('includes sessionless thoughts (planted from greenhouse while idle) without a sessionId key', () => {
    // A thought parked without an active session (e.g., from Greenhouse view)
    // should appear in the top-level export with no sessionId at all.
    const sessionless = thought({ id: 't1', text: 'Random idea' });
    delete (sessionless as Partial<ParkedThought>).sessionId;
    const data = buildExportData([summary({ id: 's1' })], [sessionless], 1_700_000_100_000);

    expect(data.sessions[0].parkedThoughts).toEqual([]);
    expect(data.parkedThoughts).toEqual([
      { id: 't1', text: 'Random idea', createdAt: 1_700_000_000_000 },
    ]);
  });

  it('preserves the order of the input summaries', () => {
    const data = buildExportData(
      [summary({ id: 's1', task: 'First' }), summary({ id: 's2', task: 'Second' })],
      [],
      1_700_000_100_000,
    );
    expect(data.sessions.map((s) => s.task)).toEqual(['First', 'Second']);
  });

  it('passes note content through from the summary unchanged', () => {
    const data = buildExportData(
      [summary({ id: 's1', noteContent: 'Remember to follow up' }), summary({ id: 's2', noteContent: null })],
      [],
      1_700_000_100_000,
    );
    expect(data.sessions[0].noteContent).toBe('Remember to follow up');
    expect(data.sessions[1].noteContent).toBeNull();
  });

  it('does not mutate its inputs', () => {
    const summaries = [summary({ id: 's1' })];
    const thoughts = [thought({ id: 't1' })];
    const summariesCopy = structuredClone(summaries);
    const thoughtsCopy = structuredClone(thoughts);

    buildExportData(summaries, thoughts, 1_700_000_100_000);

    expect(summaries).toEqual(summariesCopy);
    expect(thoughts).toEqual(thoughtsCopy);
  });

  it('omits zero intermission totals and includes nonzero totals', () => {
    const without = buildExportData([summary()], [], 1_700_000_100_000);
    expect(without.sessions[0]).not.toHaveProperty('breakIntermissionMs');
    expect(without.sessions[0]).not.toHaveProperty('touchGrassMs');

    const withTotals = buildExportData(
      [summary({ breakIntermissionMs: 60_000, touchGrassMs: 120_000 })],
      [],
      1_700_000_100_000,
    );
    expect(withTotals.sessions[0]).toMatchObject({
      breakIntermissionMs: 60_000,
      touchGrassMs: 120_000,
    });
  });

  it('includes project name and category for tagged sessions, and null for untagged', () => {
    const project: Project = {
      id: 'p1',
      name: 'Q3 Launch',
      category: 'work',
      archivedAt: null,
      createdAt: 1_700_000_000_000,
    };
    const taggedSummary = summary({ id: 's1', projectId: 'p1' });
    const untaggedSummary = summary({ id: 's2', projectId: null });

    const data = buildExportData([taggedSummary, untaggedSummary], [], 1_700_000_100_000, [project]);

    expect(data.sessions[0]).toMatchObject({
      projectName: 'Q3 Launch',
      categoryLabel: 'Work',
    });
    expect(data.sessions[1]).toMatchObject({
      projectName: null,
      categoryLabel: null,
    });
  });

  it('resolves a task\'s project into projectName/categoryLabel, unlike a session\'s optional tag', () => {
    const project: Project = { id: 'p1', name: 'Q3 Launch', category: 'work', archivedAt: null, createdAt: 1 };
    const data = buildExportData([], [], 1_700_000_100_000, [project], [task({ projectId: 'p1' })]);

    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ projectName: 'Q3 Launch', categoryLabel: 'Work' });
  });

  it('skips a task whose project cannot be found rather than exporting one with no project', () => {
    const data = buildExportData([], [], 1_700_000_100_000, [], [task({ projectId: 'missing' })]);
    expect(data.tasks).toEqual([]);
  });
});

describe('formatExportAsCsv', () => {
  it('starts with a version marker line', () => {
    const csv = formatExportAsCsv(buildExportData([], [], 1_700_000_100_000));
    const firstLine = csv.split('\n')[0];
    expect(firstLine).toBe(`Heartwood Export,${EXPORT_FORMAT_VERSION},${new Date(1_700_000_100_000).toISOString()}`);
  });

  it('renders completedAt and parked-thought createdAt as ISO 8601, not locale text', () => {
    const sessionlessThought = thought({ id: 't1', createdAt: 1_700_000_000_000 });
    delete (sessionlessThought as Partial<ParkedThought>).sessionId;
    const data = buildExportData(
      [summary({ id: 's1', completedAt: 1_700_000_000_000 })],
      [sessionlessThought],
      1_700_000_100_000,
    );
    const csv = formatExportAsCsv(data);
    const iso = new Date(1_700_000_000_000).toISOString();
    expect(csv).toContain(`s1,Write the report,${iso}`);
    expect(csv).toContain(`t1,,Check on the deploy,${iso}`);
  });

  it('includes all three table headers', () => {
    const csv = formatExportAsCsv(buildExportData([], [], 1_700_000_100_000));
    expect(csv).toContain('Sessions');
    expect(csv).toContain('id,task,completedAt,plannedFocusMs');
    expect(csv).toContain('project,category');
    expect(csv).toContain('Tasks');
    expect(csv).toContain('id,project,category,title,notes,status,priority,dueAt,position,createdAt,updatedAt');
    expect(csv).toContain('Currently Parked Thoughts');
    expect(csv).toContain('id,sessionId,text,createdAt');
  });

  it('renders a task row with its resolved project, and an empty dueAt when unset', () => {
    const project: Project = { id: 'p1', name: 'Q3 Launch', category: 'work', archivedAt: null, createdAt: 1 };
    const data = buildExportData([], [], 1_700_000_100_000, [project], [task({ id: 'task1', title: 'Draft the outline', priority: 'high' })]);
    const csv = formatExportAsCsv(data);
    expect(csv).toContain('task1,Q3 Launch,Work,Draft the outline,,backlog,high,,0,');
  });

  it('renders a task\'s dueAt as ISO 8601 when set', () => {
    const project: Project = { id: 'p1', name: 'Q3 Launch', category: 'work', archivedAt: null, createdAt: 1 };
    const dueAt = 1_700_000_000_000;
    const data = buildExportData([], [], 1_700_000_100_000, [project], [task({ dueAt })]);
    const csv = formatExportAsCsv(data);
    expect(csv).toContain(new Date(dueAt).toISOString());
  });

  it('renders a session row with joined parked thoughts', () => {
    const data = buildExportData(
      [summary({ id: 's1', task: 'Write the report', parkedThoughtCount: 2 })],
      [thought({ id: 't1', sessionId: 's1', text: 'First' }), thought({ id: 't2', sessionId: 's1', text: 'Second' })],
      1_700_000_100_000,
    );
    const csv = formatExportAsCsv(data);
    expect(csv).toContain('s1,Write the report');
    expect(csv).toContain('First; Second');
  });

  it('quotes fields containing commas, quotes, or newlines', () => {
    const data = buildExportData(
      [summary({ id: 's1', task: 'Fix bug, then test', noteContent: 'Line one\nHas "quotes"' })],
      [],
      1_700_000_100_000,
    );
    const csv = formatExportAsCsv(data);
    expect(csv).toContain('"Fix bug, then test"');
    expect(csv).toContain('"Line one\nHas ""quotes"""');
  });

  it('omits sessionId for a sessionless thought', () => {
    const sessionless = thought({ id: 't1', text: 'Random idea' });
    delete (sessionless as Partial<ParkedThought>).sessionId;
    const csv = formatExportAsCsv(buildExportData([], [sessionless], 1_700_000_100_000));
    expect(csv).toContain('t1,,Random idea');
  });

  it('includes project and category in CSV rows for tagged and untagged sessions', () => {
    const project: Project = {
      id: 'p1',
      name: 'Marketing',
      category: 'work',
      archivedAt: null,
      createdAt: 1_700_000_000_000,
    };
    const taggedSummary = summary({ id: 's1', task: 'Tagged task', projectId: 'p1' });
    const untaggedSummary = summary({ id: 's2', task: 'Untagged task', projectId: null });

    const data = buildExportData([taggedSummary, untaggedSummary], [], 1_700_000_100_000, [project]);
    const csv = formatExportAsCsv(data);

    // Tagged session should have project name and category
    expect(csv).toContain('s1,Tagged task');
    expect(csv).toContain(',Marketing,Work');

    // Untagged session should have empty project and category
    expect(csv).toContain('s2,Untagged task');
    const lines = csv.split('\n');
    const untaggedLine = lines.find((l) => l.includes('s2,Untagged task'));
    expect(untaggedLine).toContain(',');
    const fields = untaggedLine!.split(',');
    expect(fields[fields.length - 2]).toBe(''); // project should be empty
    expect(fields[fields.length - 1]).toBe(''); // category should be empty
  });
});

describe('formatExportAsMarkdown', () => {
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

  it('includes both section headers and the exported-at timestamp', () => {
    const data = buildExportData([], [], 1_700_000_100_000);
    const md = formatExportAsMarkdown(data);
    expect(md).toContain('# Heartwood Export');
    expect(md).toContain('## Session History');
    expect(md).toContain('## Currently Parked Thoughts');
  });

  it('shows empty-state text when there are no sessions or parked thoughts', () => {
    const md = formatExportAsMarkdown(buildExportData([], [], 1_700_000_100_000));
    expect(md).toContain('_No completed sessions._');
    expect(md).toContain('_Nothing currently parked._');
  });

  it('renders a session summary with its still-parked thoughts', () => {
    const data = buildExportData(
      [summary({ id: 's1', task: 'Write the report', parkedThoughtCount: 1 })],
      [thought({ sessionId: 's1', text: 'Check on the deploy' })],
      1_700_000_100_000,
    );
    const md = formatExportAsMarkdown(data);
    expect(md).toContain('### Write the report');
    expect(md).toContain('- Check on the deploy');
  });

  it('shows "planned" only when the session finished early', () => {
    const onTime = formatExportAsMarkdown(
      buildExportData([summary({ actualFocusMs: 25 * 60_000, plannedFocusMs: 25 * 60_000 })], [], 1_700_000_100_000),
    );
    expect(onTime).not.toContain('planned');

    const early = formatExportAsMarkdown(
      buildExportData([summary({ actualFocusMs: 10 * 60_000, plannedFocusMs: 25 * 60_000 })], [], 1_700_000_100_000),
    );
    expect(early).toContain('planned 25:00');
  });

  it('includes flow and break lines only when present', () => {
    const withoutEither = formatExportAsMarkdown(
      buildExportData([summary({ flowMs: 0, breakMs: 0 })], [], 1_700_000_100_000),
    );
    expect(withoutEither).not.toContain('- Flow:');
    expect(withoutEither).not.toContain('- Break:');

    const withBoth = formatExportAsMarkdown(
      buildExportData([summary({ flowMs: 5 * 60_000, breakMs: 3 * 60_000 })], [], 1_700_000_100_000),
    );
    expect(withBoth).toContain('- Flow: 05:00');
    expect(withBoth).toContain('- Break: 03:00');
  });

  it('includes intermission totals only when present', () => {
    const without = formatExportAsMarkdown(buildExportData([summary()], [], 1_700_000_100_000));
    expect(without).not.toContain('- Breaks:');
    expect(without).not.toContain('- Touch Grass:');

    const withTotals = formatExportAsMarkdown(
      buildExportData(
        [summary({ breakIntermissionMs: 60_000, touchGrassMs: 120_000 })],
        [],
        1_700_000_100_000,
      ),
    );
    expect(withTotals).toContain('- Breaks: 01:00');
    expect(withTotals).toContain('- Touch Grass: 02:00');
  });

  it('lists currently parked thoughts with their parked-at time', () => {
    const data = buildExportData([], [thought({ text: 'Reply to Sam' })], 1_700_000_100_000);
    const md = formatExportAsMarkdown(data);
    expect(md).toContain('- Reply to Sam');
  });

  it('renders note content as a blockquote under its session when present', () => {
    const data = buildExportData(
      [summary({ task: 'Write the report', noteContent: 'Line one\nLine two' })],
      [],
      1_700_000_100_000,
    );
    const md = formatExportAsMarkdown(data);
    expect(md).toContain('- Note:');
    expect(md).toContain('  > Line one');
    expect(md).toContain('  > Line two');
  });

  it('omits the note section entirely when there is no note content', () => {
    const data = buildExportData([summary({ noteContent: null })], [], 1_700_000_100_000);
    const md = formatExportAsMarkdown(data);
    expect(md).not.toContain('- Note:');
  });

  it('includes project line with name and category for tagged sessions, and em-dash for untagged', () => {
    const project: Project = {
      id: 'p1',
      name: 'Backend API',
      category: 'study',
      archivedAt: null,
      createdAt: 1_700_000_000_000,
    };
    const taggedSummary = summary({ id: 's1', task: 'Tagged task', projectId: 'p1' });
    const untaggedSummary = summary({ id: 's2', task: 'Untagged task', projectId: null });

    const data = buildExportData([taggedSummary, untaggedSummary], [], 1_700_000_100_000, [project]);
    const md = formatExportAsMarkdown(data);

    // Tagged session should show project and category
    expect(md).toContain('### Tagged task');
    expect(md).toContain('- Project: Backend API (Study)');

    // Untagged session should show em-dash
    expect(md).toContain('### Untagged task');
    expect(md).toContain('- Project: —');
  });

  it('renders a Tasks section with each task\'s project, status, priority, and due date', () => {
    const project: Project = { id: 'p1', name: 'Backend API', category: 'study', archivedAt: null, createdAt: 1 };
    const dueAt = 1_700_000_000_000;
    const data = buildExportData(
      [],
      [],
      1_700_000_100_000,
      [project],
      [task({ title: 'Draft the outline', priority: 'high', status: 'todo', dueAt, notes: 'Keep it short' })],
    );
    const md = formatExportAsMarkdown(data);

    expect(md).toContain('## Tasks');
    expect(md).toContain('### Draft the outline');
    expect(md).toContain('- Project: Backend API (Study)');
    expect(md).toContain('- Status: To Do');
    expect(md).toContain('- Priority: High');
    expect(md).toContain('- Due: ');
    expect(md).toContain('- Notes:');
    expect(md).toContain('  > Keep it short');
  });

  it('shows "_No tasks._" when there are none', () => {
    const md = formatExportAsMarkdown(buildExportData([], [], 1_700_000_100_000));
    expect(md).toContain('_No tasks._');
  });
});
