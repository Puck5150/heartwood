import { describe, expect, it, vi } from 'vitest';
import { createUpdateController } from './updateController.svelte';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createUpdateController', () => {
  it('starts idle and never checks until startCheck() is called', () => {
    const checkForUpdate = vi.fn();
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });

    expect(controller.stage).toBe('idle');
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('goes checking -> idle when no update is available', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue(null);
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });

    controller.startCheck();
    expect(controller.stage).toBe('checking');
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('idle');
    expect(controller.version).toBeNull();
  });

  it('goes checking -> available with the found version', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue({
      version: '0.1.0-alpha.4',
      downloadAndInstall: vi.fn(),
    });
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });

    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('available');
    expect(controller.version).toBe('0.1.0-alpha.4');
  });

  it('a failed check is silent: stays idle, no error', async () => {
    const checkForUpdate = vi.fn().mockRejectedValue(new Error('network down'));
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });

    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('idle');
    expect(controller.error).toBeNull();
  });

  it('startDownload() goes available -> downloading -> ready on success', async () => {
    const downloadAndInstall = deferred<void>();
    const checkForUpdate = vi.fn().mockResolvedValue({
      version: '0.1.0-alpha.4',
      downloadAndInstall: () => downloadAndInstall.promise,
    });
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });
    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    controller.startDownload();
    expect(controller.stage).toBe('downloading');

    downloadAndInstall.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('ready');
  });

  it('a failed download surfaces a dismissible, retryable error', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue({
      version: '0.1.0-alpha.4',
      downloadAndInstall: vi.fn().mockRejectedValue(new Error('checksum mismatch')),
    });
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });
    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    controller.startDownload();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.stage).toBe('available');
    expect(controller.error).toBe("Couldn't update.");

    controller.dismiss();
    expect(controller.stage).toBe('idle');
    expect(controller.error).toBeNull();
  });

  it('restart() calls relaunch only from the ready stage', async () => {
    const relaunch = vi.fn().mockResolvedValue(undefined);
    const controller = createUpdateController({ checkForUpdate: vi.fn().mockResolvedValue(null), relaunch });

    controller.restart();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('dismiss() from available returns to idle without downloading', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue({
      version: '0.1.0-alpha.4',
      downloadAndInstall: vi.fn(),
    });
    const controller = createUpdateController({ checkForUpdate, relaunch: vi.fn() });
    controller.startCheck();
    await Promise.resolve();
    await Promise.resolve();

    controller.dismiss();

    expect(controller.stage).toBe('idle');
  });
});
