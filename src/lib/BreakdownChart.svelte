<script lang="ts">
  import { onMount } from 'svelte';
  import BarChartIcon from 'lucide-svelte/icons/bar-chart-2';
  import CircleIcon from 'lucide-svelte/icons/circle';
  import PieChartIcon from 'lucide-svelte/icons/pie-chart';
  import { describeArcPath, toChartSegments, type ChartType } from './breakdown';
  import { formatDuration } from './format';
  import { getSetting, setSetting } from './repository';

  let { data, onSegmentClick }: { data: { label: string; totalMs: number }[]; onSegmentClick?: (label: string) => void } =
    $props();

  const CHART_TYPE_SETTING_KEY = 'breakdown_chart_type';
  const CHART_TYPES: ChartType[] = ['bar', 'donut', 'pie'];

  let chartType = $state<ChartType>('bar');

  onMount(async () => {
    const stored = await getSetting(CHART_TYPE_SETTING_KEY);
    if (stored === 'bar' || stored === 'donut' || stored === 'pie') {
      chartType = stored;
    }
  });

  async function selectChartType(type: ChartType) {
    chartType = type;
    await setSetting(CHART_TYPE_SETTING_KEY, type);
  }

  const segments = $derived(toChartSegments(data));
  const maxMs = $derived(Math.max(1, ...data.map((d) => d.totalMs)));

  // Personal/Work/Study/Untagged-shaped data always arrives in that fixed
  // order from groupByCategory; project-drill-down data has no such fixed
  // order. Either way, opacity is assigned by position, not by identity —
  // see the plan's Global Constraints for why (no new per-theme colors).
  const OPACITIES = [1, 0.65, 0.35, 0.2];
  function opacityFor(index: number): number {
    return OPACITIES[index] ?? 0.2;
  }
</script>

<div class="breakdown-chart">
  <div class="chart-type-toggle" role="radiogroup" aria-label="Chart type">
    {#each CHART_TYPES as type (type)}
      <button
        type="button"
        class="toggle-button"
        aria-pressed={chartType === type}
        title={type}
        onclick={() => selectChartType(type)}
      >
        {#if type === 'bar'}
          <BarChartIcon size={16} aria-hidden="true" />
        {:else if type === 'donut'}
          <CircleIcon size={16} aria-hidden="true" />
        {:else}
          <PieChartIcon size={16} aria-hidden="true" />
        {/if}
      </button>
    {/each}
  </div>

  {#if chartType === 'bar'}
    <ul class="bar-list">
      {#each data as entry, index (entry.label)}
        <li>
          <button type="button" class="bar-row" onclick={() => onSegmentClick?.(entry.label)}>
            <span class="bar-label">{entry.label}</span>
            <span class="bar-track">
              <span
                class="bar-fill"
                style={`width: ${(entry.totalMs / maxMs) * 100}%; opacity: ${opacityFor(index)};`}
              ></span>
            </span>
            <span class="bar-value">{formatDuration(entry.totalMs)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else if chartType === 'donut'}
    <svg viewBox="0 0 200 200" class="donut" role="img" aria-label="Time breakdown donut chart">
      {#each segments as segment, index (segment.label)}
        {#if segment.percent > 0}
          <circle
            cx="100"
            cy="100"
            r="70"
            fill="none"
            stroke="var(--timer-accent)"
            stroke-opacity={opacityFor(index)}
            stroke-width="36"
            stroke-dasharray={`${(segment.percent / 100) * 2 * Math.PI * 70} ${2 * Math.PI * 70}`}
            stroke-dashoffset={-((segment.startAngle / 360) * 2 * Math.PI * 70)}
            transform="rotate(-90 100 100)"
            role="button"
            tabindex="0"
            onclick={() => onSegmentClick?.(segment.label)}
            onkeydown={(e) => e.key === 'Enter' && onSegmentClick?.(segment.label)}
          >
            <title>{segment.label}: {formatDuration(segment.totalMs)}</title>
          </circle>
        {/if}
      {/each}
    </svg>
    <ul class="legend">
      {#each segments as segment, index (segment.label)}
        <li>
          <span class="swatch" style={`opacity: ${opacityFor(index)};`}></span>
          {segment.label} — {formatDuration(segment.totalMs)}
        </li>
      {/each}
    </ul>
  {:else}
    <svg viewBox="0 0 200 200" class="pie" role="img" aria-label="Time breakdown pie chart">
      {#each segments as segment, index (segment.label)}
        {#if segment.percent > 0}
          <path
            d={describeArcPath(100, 100, 90, segment.startAngle, segment.endAngle)}
            fill="var(--timer-accent)"
            fill-opacity={opacityFor(index)}
            role="button"
            tabindex="0"
            onclick={() => onSegmentClick?.(segment.label)}
            onkeydown={(e) => e.key === 'Enter' && onSegmentClick?.(segment.label)}
          >
            <title>{segment.label}: {formatDuration(segment.totalMs)}</title>
          </path>
        {/if}
      {/each}
    </svg>
    <ul class="legend">
      {#each segments as segment, index (segment.label)}
        <li>
          <span class="swatch" style={`opacity: ${opacityFor(index)};`}></span>
          {segment.label} — {formatDuration(segment.totalMs)}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .breakdown-chart {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .chart-type-toggle {
    display: flex;
    gap: 0.5rem;
    align-self: flex-end;
  }

  .toggle-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
  }

  .toggle-button[aria-pressed='true'] {
    background: var(--surface-secondary);
    color: var(--text);
    border-color: var(--timer-accent);
  }

  .bar-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .bar-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--text);
  }

  .bar-label {
    width: 6rem;
    flex-shrink: 0;
    font-size: 0.85rem;
    text-align: left;
  }

  .bar-track {
    flex: 1;
    height: 0.9rem;
    border-radius: 999px;
    background: var(--surface-secondary);
    overflow: hidden;
  }

  .bar-fill {
    display: block;
    height: 100%;
    background: var(--timer-accent);
    border-radius: 999px;
  }

  .bar-value {
    width: 4.5rem;
    flex-shrink: 0;
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    text-align: right;
  }

  .donut,
  .pie {
    width: 100%;
    max-width: 220px;
    align-self: center;
  }

  .donut circle,
  .pie path {
    cursor: pointer;
  }

  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .swatch {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 2px;
    background: var(--timer-accent);
  }
</style>
