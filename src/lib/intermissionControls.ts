import {
  INTERMISSION_DURATION_OPTIONS_MS,
  type IntermissionKind,
} from './session';

export function nextIntermissionDuration(
  kind: IntermissionKind,
  currentMs: number,
): number {
  const options = INTERMISSION_DURATION_OPTIONS_MS[kind] as readonly number[];
  // indexOf returns -1 for a currentMs outside the known options (e.g. a
  // stale/legacy value) — (-1 + 1) % length is 0, so this cycles to the
  // first option instead of throwing on an out-of-range index.
  const currentIndex = options.indexOf(currentMs);
  return options[(currentIndex + 1) % options.length]!;
}
