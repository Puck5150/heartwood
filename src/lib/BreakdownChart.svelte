<script lang="ts">
  import { onMount } from 'svelte';
  import BarChartIcon from 'lucide-svelte/icons/bar-chart-2';
  import CircleIcon from 'lucide-svelte/icons/circle';
  import PieChartIcon from 'lucide-svelte/icons/pie-chart';
  import { describeArcPath, toChartSegments, type ChartType } from './breakdown';
  import { formatDuration } from './format';
  import { getSetting, setSetting } from './repository';

  let {
    data,
    onSegmentClick,
  }: { data: { label: string; totalMs: number; key?: string }[]; onSegmentClick?: (label: string) => void } =
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
    if (index < OPACITIES.length) return OPACITIES[index];
    // Beyond the fixed 4-category set, a project drill-down can have any
    // number of entries — keep decaying instead of flattening at 0.2, so
    // a category with many projects still differentiates them by shade,
    // not by legend text alone.
    return Math.max(0.12, 0.2 - (index - OPACITIES.length + 1) * 0.02);
  }

  function handleSegmentKeydown(event: KeyboardEvent, label: string) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSegmentClick?.(label);
  }
</script>

<div class="breakdown-chart">
  <div class="chart-type-toggle" role="radiogroup" aria-label="Chart type">
    {#each CHART_TYPES as type (type)}
      <label class="toggle-button" class:selected={chartType === type} title={type}>
        <input
          type="radio"
          name="chart-type"
          value={type}
          checked={chartType === type}
          onchange={() => selectChartType(type)}
          class="toggle-input"
        />
        {#if type === 'bar'}
          <BarChartIcon size={16} aria-hidden="true" />
        {:else if type === 'donut'}
          <CircleIcon size={16} aria-hidden="true" />
        {:else}
          <PieChartIcon size={16} aria-hidden="true" />
        {/if}
      </label>
    {/each}
  </div>

  {#if chartType === 'bar'}
    <ul class="bar-list">
      {#each data as entry, index (entry.key ?? entry.label)}
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
    <svg viewBox="0 0 200 200" class="donut" role="group" aria-label="Time breakdown donut chart">
      {#each segments as segment, index (segment.key ?? segment.label)}
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
            onkeydown={(e) => handleSegmentKeydown(e, segment.label)}
          >
            <title>{segment.label}: {formatDuration(segment.totalMs)}</title>
          </circle>
        {/if}
      {/each}
    </svg>
    <ul class="legend">
      {#each segments as segment, index (segment.key ?? segment.label)}
        <li>
          <span class="swatch" style={`opacity: ${opacityFor(index)};`}></span>
          {segment.label} — {formatDuration(segment.totalMs)}
        </li>
      {/each}
    </ul>
  {:else}
    <svg viewBox="0 0 200 200" class="pie" role="group" aria-label="Time breakdown pie chart">
      {#each segments as segment, index (segment.key ?? segment.label)}
        {#if segment.percent > 0}
          <path
            d={describeArcPath(100, 100, 90, segment.startAngle, segment.endAngle)}
            fill="var(--timer-accent)"
            fill-opacity={opacityFor(index)}
            role="button"
            tabindex="0"
            onclick={() => onSegmentClick?.(segment.label)}
            onkeydown={(e) => handleSegmentKeydown(e, segment.label)}
          >
            <title>{segment.label}: {formatDuration(segment.totalMs)}</title>
          </path>
        {/if}
      {/each}
    </svg>
    <ul class="legend">
      {#each segments as segment, index (segment.key ?? segment.label)}
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
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 0.4rem;
    border: 1px solid var(--border);
    /* --surface-secondary, not --surface: this sits directly on a
       --surface card (History.svelte's .history / this component's own
       container), so a --border-only boundary against a matching
       background would fall under WCAG 1.4.11's 3:1 non-text contrast
       floor — the token pair alone measures ~1.5-1.8:1 across every
       theme. A background difference from the container is a second,
       always-present cue. */
    background: var(--surface-secondary);
    color: var(--text-muted);
    cursor: pointer;
  }

  .toggle-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .toggle-button:focus-within {
    outline: 2px solid var(--timer-accent);
    outline-offset: 2px;
  }

  .toggle-button.selected {
    background: var(--surface);
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
