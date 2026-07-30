// Browser-safe, best-effort native notification adapter. Every method is a
// no-op outside Tauri, and the real @tauri-apps/plugin-notification/window
// modules are only ever dynamically imported once isTauriFn() is true — so
// `npm run dev` outside Tauri never touches Tauri-only code, matching
// repository.ts's own Tauri/browser split.
//
// Notifications are entirely best-effort: a denial, a plugin error, or a
// disposed adapter all resolve quietly rather than throwing, since the
// in-app centered prompt and the timer itself never depend on any of this
// succeeding (see focusWarning.ts).

import { isTauri } from '@tauri-apps/api/core';

export interface NotificationPluginPort {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<'granted' | 'denied' | 'default'>;
  sendNotification(options: { title: string; body: string; silent?: boolean }): void;
}

export interface WindowPort {
  show(): Promise<void>;
  unminimize(): Promise<void>;
  setFocus(): Promise<void>;
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
  focusMainWindow(): Promise<void>;
  dispose(): Promise<void>;
}

export function createNativeNotificationAdapter(options?: {
  isTauriFn?: () => boolean;
  loadNotificationPlugin?: () => Promise<NotificationPluginPort>;
  loadWindow?: () => Promise<WindowPort>;
  logError?: (message: string, error: unknown) => void;
}): NativeNotificationAdapter {
  const isTauriFn = options?.isTauriFn ?? isTauri;
  const logError = options?.logError ?? (() => {});

  async function loadPlugin(): Promise<NotificationPluginPort> {
    if (options?.loadNotificationPlugin) return options.loadNotificationPlugin();
    const mod = await import('@tauri-apps/plugin-notification');
    return {
      isPermissionGranted: mod.isPermissionGranted,
      requestPermission: mod.requestPermission,
      sendNotification: mod.sendNotification,
    };
  }

  async function loadWindowPort(): Promise<WindowPort> {
    if (options?.loadWindow) return options.loadWindow();
    const mod = await import('@tauri-apps/api/window');
    const win = mod.getCurrentWindow();
    return {
      show: () => win.show(),
      unminimize: () => win.unminimize(),
      setFocus: () => win.setFocus(),
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

  async function focusMainWindow(): Promise<void> {
    if (disposed || !isTauriFn()) return;
    try {
      const win = await loadWindowPort();
      if (disposed) return;
      await win.show();
      await win.unminimize();
      await win.setFocus();
    } catch (err) {
      logError('Failed to focus the main window', err);
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
  }

  return { ensurePermission, notifyWarning, notifyCompletion, focusMainWindow, dispose };
}
