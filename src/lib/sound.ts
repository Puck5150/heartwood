// A small built-in tone library, plus a general "play this tone by id"
// path — used both for the alarm that plays when a focus session
// completes, and for previewing a tone before selecting it. Synthesized
// with the Web Audio API rather than bundled audio files, consistent
// with this project's minimal-footprint approach and the product brief's
// own preference for generated sound over imported audio. Every tone is
// deliberately gentle (sine waves, soft envelopes) — none are jarring
// alarms/sirens — matching this app's calm, restrained visual direction.
//
// Tone schedules (which notes, in what order, for how long) are pure,
// testable functions. Actually playing one through AudioContext is a
// browser-API side effect and isn't unit-tested — verified by ear.

export interface ToneStep {
  frequencyHz: number;
  startOffsetS: number;
  durationS: number;
}

export interface ToneDefinition {
  id: string;
  name: string;
  notesHz: number[];
  noteDurationS: number;
  gapS: number;
}

export const TONE_CATALOG: ToneDefinition[] = [
  {
    id: 'gentle-chime',
    name: 'Gentle Chime',
    notesHz: [523.25, 659.25], // C5, E5 — soft ascending third
    noteDurationS: 0.35,
    gapS: 0.05,
  },
  {
    id: 'soft-bell',
    name: 'Soft Bell',
    notesHz: [440], // A4 — a single held, gently decaying note
    noteDurationS: 0.9,
    gapS: 0,
  },
  {
    id: 'rising-arpeggio',
    name: 'Rising Arpeggio',
    notesHz: [523.25, 659.25, 783.99], // C5, E5, G5 — a full ascending triad
    noteDurationS: 0.25,
    gapS: 0.04,
  },
];

export const DEFAULT_TONE_ID = 'gentle-chime';

/** True only for a value that's actually a stable id in TONE_CATALOG —
 * used by appearance.ts to validate a persisted tone selection without
 * this module needing to know anything about settings/persistence. */
export function isToneId(value: unknown): value is string {
  return typeof value === 'string' && TONE_CATALOG.some((tone) => tone.id === value);
}

/** Looks up a tone by id, falling back to the default tone for an
 * unknown or missing id — a persisted selection referencing a tone that
 * no longer exists should never break playback. */
export function getToneDefinition(id: string): ToneDefinition {
  return (
    TONE_CATALOG.find((tone) => tone.id === id) ??
    TONE_CATALOG.find((tone) => tone.id === DEFAULT_TONE_ID)!
  );
}

/** The notes to play for a tone, in order, each with its own start
 * offset and duration in seconds relative to when playback begins. */
export function buildToneSchedule(tone: ToneDefinition): ToneStep[] {
  let offset = 0;
  return tone.notesHz.map((frequencyHz) => {
    const step: ToneStep = { frequencyHz, startOffsetS: offset, durationS: tone.noteDurationS };
    offset += tone.noteDurationS + tone.gapS;
    return step;
  });
}

/** How long a tone's full schedule takes to finish playing, in
 * milliseconds — the point at which the alarm sequence controller can
 * safely start the next repetition. Falls back to the default tone for
 * an unknown id, exactly like getToneDefinition(). */
export function getToneDurationMs(toneId: string): number {
  const schedule = buildToneSchedule(getToneDefinition(toneId));
  const last = schedule.at(-1)!;
  return Math.ceil((last.startOffsetS + last.durationS) * 1000);
}

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!sharedContext) sharedContext = new AudioContext();
  return sharedContext;
}

function playToneStep(context: AudioContext, step: ToneStep, baseTime: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = step.frequencyHz;
  oscillator.connect(gain);
  gain.connect(context.destination);

  const startTime = baseTime + step.startOffsetS;
  const endTime = startTime + step.durationS;

  // Fade in/out so the tone doesn't click at the start or end.
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.2, startTime + 0.02);
  gain.gain.linearRampToValueAtTime(0.2, endTime - 0.05);
  gain.gain.linearRampToValueAtTime(0, endTime);

  oscillator.start(startTime);
  oscillator.stop(endTime);
}

/**
 * Plays the tone with the given id (falling back to the default tone if
 * unknown). Used both for the focus-complete alarm and for previewing a
 * tone choice. Fails silently rather than surfacing an app error — a
 * missed sound cue (e.g. Web Audio unavailable, or blocked by an autoplay
 * policy that a prior user gesture didn't clear) should never interrupt
 * the actual session-completion flow.
 */
export function playTone(toneId: string): void {
  const context = getAudioContext();
  if (!context) return;
  try {
    void context.resume(); // no-op if already running; clears some autoplay-policy edge cases
    const tone = getToneDefinition(toneId);
    const baseTime = context.currentTime;
    for (const step of buildToneSchedule(tone)) {
      playToneStep(context, step, baseTime);
    }
  } catch (err) {
    console.error('Failed to play tone:', err);
  }
}
