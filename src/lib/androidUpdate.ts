import type { PendingUpdate } from './updateController.svelte';

interface UpdaterManifest {
  version: string;
  platforms: Record<string, { url: string }>;
}

/** Android's equivalent of the desktop checkForUpdate/relaunch pair
 * updateController.svelte.ts already accepts — see that file's own doc for
 * why dependencies are injected rather than importing
 * tauri-plugin-android-installer-api directly. `relaunch` is the
 * `stage === 'ready'` finalize step (see the interface), not literally a
 * restart: Android has no in-place binary replace, so this is where the
 * "install unknown apps" permission gets requested — deliberately only
 * here, once the user has actually tapped the update banner's action
 * button, not proactively when the update is first found. */
export function createAndroidUpdateSource(options: {
  fetchManifest: () => Promise<UpdaterManifest>;
  getCurrentVersion: () => Promise<string>;
  resolveDownloadPath: () => Promise<string>;
  download: (url: string, destPath: string) => Promise<void>;
  canInstall: () => Promise<boolean>;
  requestInstallPermission: () => Promise<void>;
  install: (path: string) => Promise<void>;
}): { checkForUpdate: () => Promise<PendingUpdate | null>; relaunch: () => Promise<void> } {
  // Set only once downloadAndInstall actually lands the APK — relaunch()
  // before that (shouldn't normally happen; the controller only calls it
  // from 'ready') is a deliberate no-op rather than installing a stale or
  // nonexistent path.
  let downloadedApkPath: string | null = null;

  async function checkForUpdate(): Promise<PendingUpdate | null> {
    const [manifest, currentVersion] = await Promise.all([options.fetchManifest(), options.getCurrentVersion()]);
    const entry = manifest.platforms['android-aarch64'];
    if (!entry || manifest.version === currentVersion) return null;
    return {
      version: manifest.version,
      downloadAndInstall: async () => {
        const destPath = await options.resolveDownloadPath();
        await options.download(entry.url, destPath);
        downloadedApkPath = destPath;
      },
    };
  }

  async function relaunch(): Promise<void> {
    if (!downloadedApkPath) return;
    if (!(await options.canInstall())) {
      await options.requestInstallPermission();
      if (!(await options.canInstall())) return; // declined — leave the download in place, stay on 'ready'
    }
    await options.install(downloadedApkPath);
  }

  return { checkForUpdate, relaunch };
}
