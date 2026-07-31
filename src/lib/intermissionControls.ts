import {
  INTERMISSION_DURATION_OPTIONS_MS,
  type IntermissionKind,
} from './session';

export function nextIntermissionDuration(
  kind: IntermissionKind,
  currentMs: number,
): number {
  const options = INTERMISSION_DURATION_OPTIONS_MS[kind] as readonly number[];
  const currentIndex = options.indexOf(currentMs);
  return options[(currentIndex + 1) % options.length]!;
}
