// Pure logic for the History "Breakdown" tab: time-range filtering,
// category/project grouping, and the angle/path math BreakdownChart.svelte
// needs for its donut and pie renderings. No DOM, no repository access —
// matches history.ts's and export.ts's own separation of concerns.

import type { SessionSummary } from './history';
import { CATEGORY_LABELS, type Project, type ProjectCategory } from './projects';

export type TimeRange = 'week' | 'month' | 'all';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rolling windows, not calendar-aligned — see the plan's Global
 * Constraints for why (simpler, and "the last 7 days" is what a user
 * checking in mid-week actually wants to see, not "since Sunday"). */
export function filterSummariesByRange(
  summaries: SessionSummary[],
  range: TimeRange,
  now: number,
): SessionSummary[] {
  if (range === 'all') return summaries;
  const windowMs = range === 'week' ? 7 * DAY_MS : 30 * DAY_MS;
  const cutoff = now - windowMs;
  return summaries.filter((s) => s.completedAt >= cutoff);
}

export interface CategoryTotal {
  key: ProjectCategory | 'untagged';
  label: string;
  totalMs: number;
}

/** Always includes every category plus 'untagged', even at zero, so the
 * breakdown visibly accounts for all time in range rather than silently
 * omitting an empty segment — see the design spec's Breakdown section. */
export function groupByCategory(
  summaries: SessionSummary[],
  projectsById: Map<string, Project>,
): CategoryTotal[] {
  const totals: Record<ProjectCategory | 'untagged', number> = {
    personal: 0,
    work: 0,
    study: 0,
    untagged: 0,
  };

  for (const summary of summaries) {
    const project = summary.projectId ? projectsById.get(summary.projectId) : undefined;
    const key = project ? project.category : 'untagged';
    totals[key] += summary.actualFocusMs;
  }

  return [
    { key: 'personal', label: CATEGORY_LABELS.personal, totalMs: totals.personal },
    { key: 'work', label: CATEGORY_LABELS.work, totalMs: totals.work },
    { key: 'study', label: CATEGORY_LABELS.study, totalMs: totals.study },
    { key: 'untagged', label: 'Untagged', totalMs: totals.untagged },
  ];
}

export interface ProjectTotal {
  projectId: string;
  label: string;
  totalMs: number;
}

/** Only projects with at least one session's worth of time in the
 * filtered range appear here — unlike groupByCategory, a zero-total
 * project drilled into from its (non-zero) category would be noise, not
 * useful accounting. */
export function groupByProjectInCategory(
  summaries: SessionSummary[],
  projectsById: Map<string, Project>,
  category: ProjectCategory,
): ProjectTotal[] {
  const totals = new Map<string, number>();

  for (const summary of summaries) {
    if (!summary.projectId) continue;
    const project = projectsById.get(summary.projectId);
    if (!project || project.category !== category) continue;
    totals.set(summary.projectId, (totals.get(summary.projectId) ?? 0) + summary.actualFocusMs);
  }

  return [...totals.entries()]
    .filter(([, totalMs]) => totalMs > 0)
    .map(([projectId, totalMs]) => ({
      projectId,
      label: projectsById.get(projectId)?.name ?? 'Unknown project',
      totalMs,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

export type ChartType = 'bar' | 'donut' | 'pie';

export interface ChartSegment {
  label: string;
  totalMs: number;
  /** 0-100. Zero-total entries get percent 0 and are still returned (the
   * chart renders them as empty/omitted segments, not as a data error) —
   * BreakdownChart.svelte decides whether to skip drawing a zero-width
   * wedge, this function just reports the true proportion. */
  percent: number;
  /** Degrees, 0 at the top, clockwise — matches describeArcPath's own
   * convention below. */
  startAngle: number;
  endAngle: number;
}

/** Converts a list of {label, totalMs} entries into chart segments with
 * cumulative angles. Entries with totalMs <= 0 across the board (an empty
 * range) all get percent 0 and zero-width angles rather than dividing by
 * zero. */
export function toChartSegments(entries: { label: string; totalMs: number }[]): ChartSegment[] {
  const grandTotal = entries.reduce((sum, e) => sum + e.totalMs, 0);
  let cursor = 0;
  return entries.map((entry) => {
    const percent = grandTotal > 0 ? (entry.totalMs / grandTotal) * 100 : 0;
    const sweep = grandTotal > 0 ? (entry.totalMs / grandTotal) * 360 : 0;
    const startAngle = cursor;
    const endAngle = cursor + sweep;
    cursor = endAngle;
    return { label: entry.label, totalMs: entry.totalMs, percent, startAngle, endAngle };
  });
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

/** SVG path `d` attribute for a filled pie wedge from startAngle to
 * endAngle (degrees, clockwise from the top, matching toChartSegments).
 * A full-circle wedge (360deg exactly) is nudged by 0.001deg so the arc
 * flags don't degenerate into a zero-length path — SVG's elliptical arc
 * command can't describe a complete circle in one segment. */
export function describeArcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const clampedEnd = endAngle - startAngle >= 360 ? startAngle + 359.999 : endAngle;
  const start = polarToCartesian(cx, cy, r, clampedEnd);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = clampedEnd - startAngle <= 180 ? '0' : '1';
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
}
