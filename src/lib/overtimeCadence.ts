import { FOCUS_WARNING_OPTIONS, type FocusWarningLeadMs } from './appearance';
import { getFlowElapsedMs, type SessionState } from './session';

export interface OvertimeCadenceInput {
  session: SessionState;
  now: number;
  lead: FocusWarningLeadMs;
  isForeground: boolean;
}

export interface OvertimeCadenceView {
  visible: boolean;
  phase: 'initial' | 'warning' | 'due' | null;
  markerNumber: number | null;
  leadLabel: string | null;
  announcement: string | null;
  alarmDue: boolean;
}

export interface OvertimeCadenceCoordinator {
  activateLiveExpiry(sessionId: string): void;
  evaluate(input: OvertimeCadenceInput): OvertimeCadenceView;
  acknowledge(): OvertimeCadenceView;
  dispose(): void;
}

export const EMPTY_OVERTIME_CADENCE_VIEW: OvertimeCadenceView = Object.freeze({
  visible: false,
  phase: null,
  markerNumber: null,
  leadLabel: null,
  announcement: null,
  alarmDue: false,
});

interface SessionCadenceState {
  sessionId: string;
  acknowledgedThrough: number;
  lastAlarmedMarker: number;
  exposedMarker: number | null;
  announcedMarkers: Set<number>;
  notifiedMarkers: Set<number>;
}

function leadLabelFor(lead: FocusWarningLeadMs): string | null {
  return FOCUS_WARNING_OPTIONS.find((option) => option.value === lead)?.label ?? null;
}

function isFlowSession(
  session: SessionState,
): session is Extract<SessionState, { status: 'flow' | 'flowPaused' }> {
  return session.status === 'flow' || session.status === 'flowPaused';
}

export function createOvertimeCadenceCoordinator(options: {
  notifyWarning: (task: string, leadLabel: string) => Promise<void>;
  logError?: (message: string, error: unknown) => void;
}): OvertimeCadenceCoordinator {
  const logError = options.logError ?? (() => {});

  let disposed = false;
  let liveExpirySessionId: string | null = null;
  let cadence: SessionCadenceState | null = null;

  function clearCadence(): void {
    cadence = null;
    liveExpirySessionId = null;
  }

  function stateFor(session: Extract<SessionState, { status: 'flow' | 'flowPaused' }>, latestDueMarker: number): SessionCadenceState {
    if (cadence?.sessionId === session.sessionId) return cadence;

    // liveExpiry distinguishes a session that just now crossed into
    // overtime while the app was open (start at marker 0 so marker 1's
    // "Planned focus complete" actually fires) from one resumed already in
    // overtime — e.g. the app was closed and reopened after time passed
    // silently. The latter seeds acknowledgedThrough/lastAlarmedMarker at
    // the marker already due, so it doesn't replay every check-in the user
    // never saw as one burst.
    const liveExpiry = liveExpirySessionId === session.sessionId;
    cadence = {
      sessionId: session.sessionId,
      acknowledgedThrough: liveExpiry ? 0 : latestDueMarker,
      lastAlarmedMarker: liveExpiry ? 0 : latestDueMarker,
      exposedMarker: null,
      announcedMarkers: new Set(),
      notifiedMarkers: new Set(),
    };
    liveExpirySessionId = null;
    return cadence;
  }

  function announcementFor(state: SessionCadenceState, markerNumber: number, text: string): string | null {
    if (state.announcedMarkers.has(markerNumber)) return null;
    state.announcedMarkers.add(markerNumber);
    return text;
  }

  function warningView(
    state: SessionCadenceState,
    session: Extract<SessionState, { status: 'flow' | 'flowPaused' }>,
    markerNumber: number,
    leadLabel: string,
    isForeground: boolean,
  ): OvertimeCadenceView {
    state.exposedMarker = markerNumber;
    if (!disposed && !isForeground && !state.notifiedMarkers.has(markerNumber)) {
      state.notifiedMarkers.add(markerNumber);
      void options.notifyWarning(session.task, leadLabel).catch((error) => {
        if (!disposed) logError('Failed to send overtime warning notification', error);
      });
    }
    return {
      visible: true,
      phase: 'warning',
      markerNumber,
      leadLabel,
      announcement: announcementFor(state, markerNumber, `${leadLabel} to next focus check-in`),
      alarmDue: false,
    };
  }

  function dueView(
    state: SessionCadenceState,
    markerNumber: number,
  ): OvertimeCadenceView {
    state.exposedMarker = markerNumber;
    const alarmDue = state.lastAlarmedMarker !== markerNumber;
    state.lastAlarmedMarker = markerNumber;
    const phase = markerNumber === 1 ? 'initial' : 'due';
    return {
      visible: true,
      phase,
      markerNumber,
      leadLabel: null,
      announcement: announcementFor(
        state,
        markerNumber,
        phase === 'initial' ? 'Planned focus complete' : 'Focus check-in',
      ),
      alarmDue,
    };
  }

  function activateLiveExpiry(sessionId: string): void {
    liveExpirySessionId = sessionId;
  }

  function evaluate(input: OvertimeCadenceInput): OvertimeCadenceView {
    const { session, now, lead, isForeground } = input;
    if (!isFlowSession(session)) {
      clearCadence();
      return EMPTY_OVERTIME_CADENCE_VIEW;
    }

    const elapsed = getFlowElapsedMs(session, now) ?? 0;
    const latestDueMarker = Math.floor(elapsed / session.plannedDurationMs) + 1;
    const state = stateFor(session, latestDueMarker);

    if (latestDueMarker > state.acknowledgedThrough) {
      return dueView(state, latestDueMarker);
    }

    if (lead === 'off') {
      state.exposedMarker = null;
      return EMPTY_OVERTIME_CADENCE_VIEW;
    }

    const leadMs = Number(lead);
    // The max guards against regressing to a marker already acknowledged:
    // latestDueMarker + 1 is "the next one due", but if the user just
    // acknowledged past that (evaluate() hasn't caught up to elapsed time
    // yet), the warning must target the marker *after* what's acknowledged,
    // not one that's already been dismissed.
    const markerNumber = Math.max(latestDueMarker + 1, state.acknowledgedThrough + 1);
    const nextMarkerElapsed = (markerNumber - 1) * session.plannedDurationMs;
    if (elapsed < nextMarkerElapsed - leadMs) {
      state.exposedMarker = null;
      return EMPTY_OVERTIME_CADENCE_VIEW;
    }

    const leadLabel = leadLabelFor(lead);
    if (!leadLabel) {
      state.exposedMarker = null;
      return EMPTY_OVERTIME_CADENCE_VIEW;
    }
    return warningView(state, session, markerNumber, leadLabel, isForeground);
  }

  function acknowledge(): OvertimeCadenceView {
    if (cadence?.exposedMarker !== null && cadence) {
      cadence.acknowledgedThrough = Math.max(cadence.acknowledgedThrough, cadence.exposedMarker);
      cadence.exposedMarker = null;
    }
    return EMPTY_OVERTIME_CADENCE_VIEW;
  }

  function dispose(): void {
    disposed = true;
  }

  return { activateLiveExpiry, evaluate, acknowledge, dispose };
}
