// Warning coordination lives outside the pure session state machine: it
// decides whether the centered warning prompt should be visible right
// now, and dispatches at most one announcement and one background native
// notification per focus-cycle deadline. It owns none of session.ts's
// countdown math and never calls a session transition or persists a
// setting — it's a pure function of (session, now, lead, foreground) plus
// two pieces of its own memory (which deadline it has already announced
// and notified for).
//
// `focusDeadlineAt` is the cycle identity throughout: restarting focus
// creates a new deadline, so the very next evaluate() call for that new
// deadline is treated as a fresh cycle, free to announce/notify again.

import { FOCUS_WARNING_OPTIONS, type FocusWarningLeadMs } from './appearance';
import { getFocusRemainingMs, type SessionState } from './session';

export interface FocusWarningInput {
  session: SessionState;
  now: number;
  lead: FocusWarningLeadMs;
  isForeground: boolean;
}

export interface FocusWarningView {
  visible: boolean;
  deadline: number | null;
  leadLabel: string | null;
  /** Non-null only on the one evaluate() call that first crosses the
   * threshold for a given deadline — every later call while still visible
   * returns null here, so the caller's aria-live region doesn't
   * re-announce on every render. */
  announcement: string | null;
}

export interface FocusWarningCoordinator {
  evaluate(input: FocusWarningInput): FocusWarningView;
  dispose(): void;
}

function leadLabelFor(lead: FocusWarningLeadMs): string | null {
  return FOCUS_WARNING_OPTIONS.find((option) => option.value === lead)?.label ?? null;
}

export function createFocusWarningCoordinator(options: {
  notifyWarning: (task: string, leadLabel: string) => Promise<void>;
  logError?: (message: string, error: unknown) => void;
}): FocusWarningCoordinator {
  const logError = options.logError ?? (() => {});

  let disposed = false;
  let lastAnnouncedCycleKey: number | null = null;
  let lastNotifiedCycleKey: number | null = null;

  function evaluate(input: FocusWarningInput): FocusWarningView {
    const { session, now, lead, isForeground } = input;

    const deadline = session.status === 'focusing' || session.status === 'paused' ? session.focusDeadlineAt : null;
    // Pause/resume shifts focusDeadlineAt forward by exactly the pause
    // duration while accumulatedPauseMs grows by that same amount — their
    // difference is therefore invariant across any number of pauses
    // within one cycle, but changes on a genuine restart (which resets
    // focusDeadlineAt without touching accumulatedPauseMs). This, not the
    // raw deadline, is what "the same cycle" actually means here.
    const cycleKey =
      session.status === 'focusing' || session.status === 'paused'
        ? session.focusDeadlineAt - session.accumulatedPauseMs
        : null;

    if (session.status !== 'focusing' || lead === 'off') {
      return { visible: false, deadline, leadLabel: null, announcement: null };
    }

    const leadMs = Number(lead);
    const remaining = getFocusRemainingMs(session, now) ?? 0;
    const visible = remaining <= leadMs;
    const leadLabel = leadLabelFor(lead);

    if (!visible) {
      return { visible: false, deadline, leadLabel, announcement: null };
    }

    const isNewCycle = lastAnnouncedCycleKey !== cycleKey;
    if (isNewCycle) lastAnnouncedCycleKey = cycleKey;

    if (!disposed && !isForeground && lastNotifiedCycleKey !== cycleKey && leadLabel) {
      lastNotifiedCycleKey = cycleKey;
      void options.notifyWarning(session.task, leadLabel).catch((err) => {
        if (disposed) return;
        logError('Failed to send focus-warning notification', err);
      });
    }

    return {
      visible: true,
      deadline,
      leadLabel,
      announcement: isNewCycle ? `${leadLabel} left` : null,
    };
  }

  function dispose(): void {
    disposed = true;
  }

  return { evaluate, dispose };
}
