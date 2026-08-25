import { describe, expect, it, vi } from 'vitest';
import { createAndroidUpdateSource } from './androidUpdate';

function baseOptions(overrides: Partial<Parameters<typeof createAndroidUpdateSource>[0]> = {}) {
  return {
    fetchManifest: vi.fn().mockResolvedValue({
      version: '0.1.0-beta.5',
      platforms: { 'android-aarch64': { url: 'https://example.test/Heartwood_beta.5.apk' } },
    }),
    getCurrentVersion: vi.fn().mockResolvedValue('0.1.0-beta.4'),
    resolveDownloadPath: vi.fn().mockResolvedValue('/cache/update.apk'),
    download: vi.fn().mockResolvedValue(undefined),
    canInstall: vi.fn().mockResolvedValue(true),
    requestInstallPermission: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createAndroidUpdateSource: checkForUpdate', () => {
  it('returns the manifest version when it differs from the installed version', async () => {
    const options = baseOptions();
    const source = createAndroidUpdateSource(options);

    const result = await source.checkForUpdate();

    expect(result?.version).toBe('0.1.0-beta.5');
  });

  it('returns null when the installed version already matches the manifest', async () => {
    const options = baseOptions({ getCurrentVersion: vi.fn().mockResolvedValue('0.1.0-beta.5') });
    const source = createAndroidUpdateSource(options);

    expect(await source.checkForUpdate()).toBeNull();
  });

  it('returns null when the manifest has no android-aarch64 entry', async () => {
    const options = baseOptions({
      fetchManifest: vi.fn().mockResolvedValue({ version: '0.1.0-beta.5', platforms: {} }),
    });
    const source = createAndroidUpdateSource(options);

    expect(await source.checkForUpdate()).toBeNull();
  });
});

describe('createAndroidUpdateSource: downloadAndInstall', () => {
  it('downloads the manifest URL to the resolved path', async () => {
    const options = baseOptions();
    const source = createAndroidUpdateSource(options);

    const pending = await source.checkForUpdate();
    await pending?.downloadAndInstall();

    expect(options.download).toHaveBeenCalledWith('https://example.test/Heartwood_beta.5.apk', '/cache/update.apk');
  });
});

describe('createAndroidUpdateSource: relaunch (finalize)', () => {
  it('installs directly when permission is already granted', async () => {
    const options = baseOptions();
    const source = createAndroidUpdateSource(options);
    const pending = await source.checkForUpdate();
    await pending?.downloadAndInstall();

    await source.relaunch();

    expect(options.requestInstallPermission).not.toHaveBeenCalled();
    expect(options.install).toHaveBeenCalledWith('/cache/update.apk');
  });

  it('requests permission first when not yet granted, then installs once granted', async () => {
    const canInstall = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const options = baseOptions({ canInstall });
    const source = createAndroidUpdateSource(options);
    const pending = await source.checkForUpdate();
    await pending?.downloadAndInstall();

    await source.relaunch();

    expect(options.requestInstallPermission).toHaveBeenCalledOnce();
    expect(options.install).toHaveBeenCalledWith('/cache/update.apk');
  });

  it('never installs if the user declines the permission request', async () => {
    const canInstall = vi.fn().mockResolvedValue(false);
    const options = baseOptions({ canInstall });
    const source = createAndroidUpdateSource(options);
    const pending = await source.checkForUpdate();
    await pending?.downloadAndInstall();

    await source.relaunch();

    expect(options.requestInstallPermission).toHaveBeenCalledOnce();
    expect(options.install).not.toHaveBeenCalled();
  });

  it('is a no-op if called before any download happened', async () => {
    const options = baseOptions();
    const source = createAndroidUpdateSource(options);

    await source.relaunch();

    expect(options.canInstall).not.toHaveBeenCalled();
    expect(options.install).not.toHaveBeenCalled();
  });
});
