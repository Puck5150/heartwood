// Browser-safe, best-effort native notification adapter. Every method is a
// no-op outside Tauri, and the real @tauri-apps/plugin-notification module
// is only ever dynamically imported once isTauriFn() is true — so
// `npm run dev` outside Tauri never touches Tauri-only code, matching
// repository.ts's own Tauri/browser split.
//
// Notifications are entirely best-effort: a denial, a plugin error, or a
// disposed adapter all resolve quietly rather than throwing, since the
// in-app centered prompt and the timer itself never depend on any of this
// succeeding (see focusWarning.ts). Failures are still logged (via
// console.error by default) — "best-effort" means the timer never depends
// on this succeeding, not that failures vanish silently.
//
// Deliberately does not attempt notification-click-to-focus: verified
// against the installed tauri-plugin-notification 2.3.3 source (not just
// its TypeScript declarations), the desktop backend (src/desktop.rs) only
// implements show()/request_permission()/permission_state() — no action or
// activation event is ever emitted on desktop, and the plugin's
// invoke_handler registers no listener-registration command for it either.
// Its `onAction()` JS export only ever fires on mobile (registerActionTypes
// exists solely in src/mobile.rs). Wiring `onAction()` here would register
// a listener for a plugin event the desktop backend can never emit — dead
// code masquerading as a feature. See README's own platform-limitations
// note for the user-facing version of this.

import { isTauri } from '@tauri-apps/api/core';

export interface NotificationPluginPort {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<'granted' | 'denied' | 'default'>;
  sendNotification(options: { title: string; body: string; silent?: boolean }): void;
}

export interface NativeNotificationAdapter {
  /** Checks (and, at most once per adapter lifetime, requests) permission.
   * Concurrent callers share the same in-flight request. Never called by
   * notifyWarning()/notifyCompletion() themselves — only an explicit
   * ensurePermission() call may prompt. */
  ensurePermission(): Promise<boolean>;
  /** Sends only if a prior ensurePermission() resolved granted — never
   * prompts. Body/title are built only from `task`/`leadLabel`, never
   * note or parked-thought content. */
  notifyWarning(task: string, leadLabel: string): Promise<void>;
  notifyCompletion(task: string): Promise<void>;
  notifyIntermissionReturn(kind: 'break' | 'touchGrass', task: string): Promise<void>;
  dispose(): Promise<void>;
}

export function createNativeNotificationAdapter(options?: {
  isTauriFn?: () => boolean;
  loadNotificationPlugin?: () => Promise<NotificationPluginPort>;
  logError?: (message: string, error: unknown) => void;
}): NativeNotificationAdapter {
  const isTauriFn = options?.isTauriFn ?? isTauri;
  const logError = options?.logError ?? ((message, error) => console.error(message, error));

  async function loadPlugin(): Promise<NotificationPluginPort> {
    if (options?.loadNotificationPlugin) return options.loadNotificationPlugin();
    const mod = await import('@tauri-apps/plugin-notification');
    return {
      isPermissionGranted: mod.isPermissionGranted,
      requestPermission: mod.requestPermission,
      sendNotification: mod.sendNotification,
    };
  }

  let disposed = false;
  let grantedKnown = false;
  let permissionPromise: Promise<boolean> | null = null;

  function ensurePermission(): Promise<boolean> {
    if (disposed || !isTauriFn()) return Promise.resolve(false);
    if (!permissionPromise) {
      permissionPromise = (async () => {
        try {
          const plugin = await loadPlugin();
          if (disposed) return false;
          if (await plugin.isPermissionGranted()) return true;
          if (disposed) return false;
          const permission = await plugin.requestPermission();
          return permission === 'granted';
        } catch (err) {
          logError('Failed to check/request notification permission', err);
          return false;
        }
      })().then((granted) => {
        if (!disposed) grantedKnown = granted;
        return disposed ? false : granted;
      });
    }
    return permissionPromise;
  }

  async function send(payload: { title: string; body: string }): Promise<void> {
    if (disposed || !isTauriFn() || !grantedKnown) return;
    try {
      const plugin = await loadPlugin();
      if (disposed) return;
      // silent: true, no `sound` — the app's own three-tone alarm sequence
      // is the only audible completion cue (design's own requirement).
      plugin.sendNotification({ ...payload, silent: true });
    } catch (err) {
      logError('Failed to send notification', err);
    }
  }

  function notifyWarning(task: string, leadLabel: string): Promise<void> {
    return send({ title: `${leadLabel} left`, body: task });
  }

  function notifyCompletion(task: string): Promise<void> {
    return send({ title: 'Planned focus complete', body: task });
  }

  function notifyIntermissionReturn(kind: 'break' | 'touchGrass', task: string): Promise<void> {
    return send({
      title: kind === 'break' ? 'Break time is up' : 'Touch Grass time is up',
      body: task,
    });
  }

  async function dispose(): Promise<void> {
    disposed = true;
  }

  return { ensurePermission, notifyWarning, notifyCompletion, notifyIntermissionReturn, dispose };
}
