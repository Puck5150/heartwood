// Drives the update-check/download/restart state machine. Dependencies
// (checking for an update, relaunching the app) are injected exactly like
// settingsController.svelte.ts's `persist` — this module never imports
// @tauri-apps/plugin-updater or @tauri-apps/plugin-process directly, so
// tests can substitute fakes instead of a real Tauri runtime.
//
// A failed check is silent by design (see the auto-updater design spec):
// checking is opportunistic, never worth alarming a tester over, so a
// check failure simply returns to 'idle' with no error surfaced. A failed
// download/install *is* surfaced, because at that point the user has
// already explicitly asked for the update.

export type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'restarting';

export interface PendingUpdate {
  version: string;
  downloadAndInstall: () => Promise<void>;
}

export interface UpdateController {
  readonly stage: UpdateStage;
  readonly version: string | null;
  readonly error: string | null;
  startCheck(): void;
  startDownload(): void;
  dismiss(): void;
  restart(): void;
}

export function createUpdateController(options: {
  checkForUpdate: () => Promise<PendingUpdate | null>;
  relaunch: () => Promise<void>;
}): UpdateController {
  let stage = $state<UpdateStage>('idle');
  let version = $state<string | null>(null);
  let error = $state<string | null>(null);
  let pending: PendingUpdate | null = null;

  function startCheck(): void {
    if (stage !== 'idle') return;
    stage = 'checking';
    void options
      .checkForUpdate()
      .then((update) => {
        if (stage !== 'checking') return;
        if (!update) {
          stage = 'idle';
          return;
        }
        pending = update;
        version = update.version;
        stage = 'available';
      })
      .catch(() => {
        if (stage !== 'checking') return;
        stage = 'idle';
      });
  }

  function startDownload(): void {
    if (stage !== 'available' || !pending) return;
    const update = pending;
    stage = 'downloading';
    error = null;
    void update
      .downloadAndInstall()
      .then(() => {
        if (stage !== 'downloading') return;
        stage = 'ready';
      })
      .catch(() => {
        if (stage !== 'downloading') return;
        stage = 'available';
        error = "Couldn't update.";
      });
  }

  function dismiss(): void {
    stage = 'idle';
    error = null;
    pending = null;
    version = null;
  }

  function restart(): void {
    if (stage !== 'ready') return;
    stage = 'restarting';
    void options.relaunch();
  }

  return {
    get stage() {
      return stage;
    },
    get version() {
      return version;
    },
    get error() {
      return error;
    },
    startCheck,
    startDownload,
    dismiss,
    restart,
  };
}
