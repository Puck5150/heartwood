import { describe, expect, it } from 'vitest';
import { buildExportData, EXPORT_FORMAT_VERSION, formatExportAsJson, formatExportAsMarkdown } from './export';
import type { SessionSummary } from './history';
import type { ParkedThought } from './parkingLot';

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
    totalElapsedMs: 25 * 60_000,
    parkedThoughtCount: 0,
    noteContent: null,
    revisionCount: 0,
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

describe('buildExportData', () => {
  it('produces an empty payload for no sessions and no parked thoughts', () => {
    const data = buildExportData([], [], 1_700_000_100_000);
    expect(data).toEqual({
      version: EXPORT_FORMAT_VERSION,
      exportedAt: 1_700_000_100_000,
      sessions: [],
      parkedThoughts: [],
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
});

describe('formatExportAsJson', () => {
  it('produces valid JSON that round-trips back to the same data', () => {
    const data = buildExportData(
      [summary({ id: 's1', parkedThoughtCount: 1 })],
      [thought({ sessionId: 's1' })],
      1_700_000_100_000,
    );
    const json = formatExportAsJson(data);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toEqual(data);
  });
});

describe('formatExportAsMarkdown', () => {
  it('includes both section headers and the exported-at timestamp', () => {
    const data = buildExportData([], [], 1_700_000_100_000);
    const md = formatExportAsMarkdown(data);
    expect(md).toContain('# Pomodoro Parking Lot Export');
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
});
