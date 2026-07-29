// The visible workspace is independent of session/timer state (see
// App.svelte's module doc). Focus is the main session surface; History and
// Revisions are read-only views that must never block on, reset, or
// otherwise own the timer.
export type WorkspaceView = 'focus' | 'history' | 'revisions';
