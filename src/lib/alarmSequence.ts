// A small, injected controller for focus-completion and intermission-return
// alarms: plays the selected tone a fixed number of times in a row, each one
// a full schedule duration plus a fixed gap apart, and can be cancelled at
// any point by session actions that make continued ringing wrong (the user
// already acted). Deliberately separate from playTone()/sound.ts itself —
// Settings preview must stay a single, uncancellable playback, never this
// three-repetition sequence.
//
// Uses one monotonically increasing generation number rather than
// tracking "the current timeout" as the sole cancellation mechanism: a
// timeout already in flight when cancel() or a new start() runs captures
// its own generation in a closure, so it can recognize itself as stale and
// no-op instead of needing to be found and cleared first. clearTimeout is
// still called as a courtesy (freeing the pending timer immediately rather
// than waiting for it to fire and self-reject).

export interface AlarmSequence {
  start(toneId: string): void;
  cancel(): void;
}

export function createAlarmSequence(options: {
  playOnce: (toneId: string) => void;
  durationMs: (toneId: string) => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  repetitions?: number;
  /** Silence between the end of one repetition's schedule and the start
   * of the next. Defaults to 500ms so the three tones read as distinct
   * repetitions rather than a single run-on playback. */
  gapMs?: number;
}): AlarmSequence {
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const repetitions = options.repetitions ?? 3;
  const gapMs = options.gapMs ?? 500;

  let generation = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    generation += 1;
    if (timeout !== null) clearTimeoutFn(timeout);
    timeout = null;
  }

  function start(toneId: string): void {
    cancel();
    const run = generation;
    let played = 0;

    const playNext = () => {
      if (run !== generation || played >= repetitions) return;
      options.playOnce(toneId);
      played += 1;
      if (played < repetitions) {
        timeout = setTimeoutFn(playNext, options.durationMs(toneId) + gapMs);
      }
    };

    playNext();
  }

  return { start, cancel };
}
