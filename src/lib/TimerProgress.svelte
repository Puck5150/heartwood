<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { TimerProgressStyle } from './appearance';

  let {
    progress,
    style,
    children,
  }: {
    /** 0 at session start, 1 at the planned deadline. Clamped defensively —
     * callers already clamp, but a redrawn arc must never read outside
     * [0, 1] even from a stale/rounding-edge value. */
    progress: number;
    style: TimerProgressStyle;
    /** The clock readout — rendered nested inside the ring for `ring`, or
     * below the arc for `crown`/`cap`, matching each style's own approved
     * mockup layout. */
    children: Snippet;
  } = $props();

  const clamped = $derived(Math.min(1, Math.max(0, progress)));

  // Semicircle arcs (crown/cap): path length is exactly pi * r for a
  // 180-degree arc, independent of the path's start/end coordinates.
  const CROWN_RADIUS = 90;
  const CAP_RADIUS = 80;
  const CROWN_LENGTH = Math.PI * CROWN_RADIUS;
  const CAP_LENGTH = Math.PI * CAP_RADIUS;
  const CROWN_PATH = `M20,120 A${CROWN_RADIUS},${CROWN_RADIUS} 0 0 1 200,120`;
  const CAP_PATH = `M10,55 A${CAP_RADIUS},${CAP_RADIUS} 0 0 1 170,55`;

  // Full ring: standard circumference, drawn starting at 12 o'clock via
  // the -90deg rotation rather than the SVG default of 3 o'clock.
  const RING_RADIUS = 88;
  const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
</script>

{#if style === 'ring'}
  <div class="ring-wrap">
    <svg class="ring-svg" viewBox="0 0 200 200" role="presentation">
      <circle class="ring-track" cx="100" cy="100" r={RING_RADIUS} />
      <circle
        class="ring-fill"
        cx="100"
        cy="100"
        r={RING_RADIUS}
        stroke-dasharray={RING_LENGTH}
        stroke-dashoffset={RING_LENGTH * (1 - clamped)}
        transform="rotate(-90 100 100)"
      />
    </svg>
    <div class="ring-content">
      {@render children()}
    </div>
  </div>
{:else if style === 'crown'}
  <svg class="arc-svg crown" viewBox="0 0 220 130" role="presentation">
    <path class="arc-track" d={CROWN_PATH} />
    <path
      class="arc-fill"
      d={CROWN_PATH}
      stroke-dasharray={CROWN_LENGTH}
      stroke-dashoffset={CROWN_LENGTH * (1 - clamped)}
    />
  </svg>
  {@render children()}
{:else}
  <svg class="arc-svg cap" viewBox="0 0 180 60" role="presentation">
    <path class="arc-track" d={CAP_PATH} />
    <path
      class="arc-fill"
      d={CAP_PATH}
      stroke-dasharray={CAP_LENGTH}
      stroke-dashoffset={CAP_LENGTH * (1 - clamped)}
    />
  </svg>
  {@render children()}
{/if}

<style>
  .arc-track,
  .ring-track {
    fill: none;
    stroke: var(--timer-track);
  }

  .arc-fill,
  .ring-fill {
    fill: none;
    stroke: var(--timer-accent);
    stroke-linecap: round;
    /* Animates a paint property, not a layout one — this is the whole
       point of the redesign: the linear bar it replaced transitioned
       `width`, which forces a layout recalculation on every tick. */
    transition: stroke-dashoffset 0.3s linear;
  }

  .arc-svg.crown {
    display: block;
    width: min(100%, 22rem);
    margin: 0 auto;
  }

  .arc-svg.crown .arc-track,
  .arc-svg.crown .arc-fill {
    stroke-width: 12;
  }

  .arc-svg.cap {
    display: block;
    width: min(100%, 14rem);
    margin: 0 auto -0.5rem;
  }

  .arc-svg.cap .arc-track,
  .arc-svg.cap .arc-fill {
    stroke-width: 6;
  }

  .ring-wrap {
    position: relative;
    display: grid;
    place-items: center;
    width: min(100%, 15rem);
    margin: 0 auto;
  }

  .ring-svg {
    grid-area: 1 / 1;
    width: 100%;
    height: auto;
  }

  .ring-svg .ring-track,
  .ring-svg .ring-fill {
    stroke-width: 8;
  }

  .ring-content {
    grid-area: 1 / 1;
  }
</style>
