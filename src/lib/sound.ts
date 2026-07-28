// A short, gentle chime that plays when a focus session completes on its
// own — synthesized with the Web Audio API rather than a bundled audio
// file, consistent with this project's minimal-footprint approach and the
// product brief's own preference for generated sound over imported audio.
// Deliberately soft (a two-note ascending third, not a jarring alarm/siren)
// to match this app's calm, restrained visual and product direction.
//
// The schedule (what tones, in what order, for how long) is a pure,
// testable function. Actually playing it is a Web Audio API side effect
// and isn't unit-tested — verified by ear in both the browser and Tauri.

export interface ToneStep {
  frequencyHz: number;
  startOffsetS: number;
  durationS: number;
}

const NOTE_FREQUENCIES_HZ = [523.25, 659.25]; // C5, E5
const NOTE_DURATION_S = 0.35;
const GAP_S = 0.05;

/** The tones to play, in order, each with its own start offset and
 * duration in seconds relative to when playback begins. */
export function buildFocusCompleteChimeSchedule(): ToneStep[] {
  let offset = 0;
  return NOTE_FREQUENCIES_HZ.map((frequencyHz) => {
    const step: ToneStep = { frequencyHz, startOffsetS: offset, durationS: NOTE_DURATION_S };
    offset += NOTE_DURATION_S + GAP_S;
    return step;
  });
}

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!sharedContext) sharedContext = new AudioContext();
  return sharedContext;
}

function playTone(context: AudioContext, step: ToneStep, baseTime: number) {
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
 * Plays the focus-complete chime. Fails silently rather than surfacing an
 * app error — a missed sound cue (e.g. Web Audio unavailable, or blocked
 * by an autoplay policy that a prior user gesture didn't clear) should
 * never interrupt the actual session-completion flow.
 */
export function playFocusCompleteChime(): void {
  const context = getAudioContext();
  if (!context) return;
  try {
    void context.resume(); // no-op if already running; clears some autoplay-policy edge cases
    const baseTime = context.currentTime;
    for (const step of buildFocusCompleteChimeSchedule()) {
      playTone(context, step, baseTime);
    }
  } catch (err) {
    console.error('Failed to play focus-complete chime:', err);
  }
}
