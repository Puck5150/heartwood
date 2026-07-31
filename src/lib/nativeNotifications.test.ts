import { describe, expect, it, vi } from 'vitest';
import { createNativeNotificationAdapter } from './nativeNotifications';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakePlugin(overrides: {
  isPermissionGranted?: () => Promise<boolean>;
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
  sendNotification?: (options: { title: string; body: string; silent?: boolean }) => void;
} = {}) {
  return {
    isPermissionGranted: vi.fn(overrides.isPermissionGranted ?? (async () => false)),
    requestPermission: vi.fn(overrides.requestPermission ?? (async () => 'granted' as const)),
    sendNotification: vi.fn(overrides.sendNotification ?? (() => {})),
  };
}

describe('createNativeNotificationAdapter', () => {
  it('is a no-op in browser mode and never imports the plugin', async () => {
    const loadNotificationPlugin = vi.fn();
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => false,
      loadNotificationPlugin,
    });

    expect(await adapter.ensurePermission()).toBe(false);
    await adapter.notifyWarning('Task', '30 seconds');
    await adapter.notifyCompletion('Task');
    await adapter.notifyIntermissionReturn('break', 'Task');

    expect(loadNotificationPlugin).not.toHaveBeenCalled();
  });

  it('reuses an already-granted permission without prompting', async () => {
    const plugin = fakePlugin({ isPermissionGranted: vi.fn(async () => true) });
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });

    expect(await adapter.ensurePermission()).toBe(true);
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it('requests permission only once per adapter lifetime, even across many calls', async () => {
    const plugin = fakePlugin();
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });

    expect(await adapter.ensurePermission()).toBe(true);
    expect(await adapter.ensurePermission()).toBe(true);
    expect(await adapter.ensurePermission()).toBe(true);
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('remembers a denial and never re-prompts', async () => {
    const plugin = fakePlugin({ requestPermission: vi.fn(async () => 'denied' as const) });
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });

    expect(await adapter.ensurePermission()).toBe(false);
    expect(await adapter.ensurePermission()).toBe(false);
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request across concurrent callers', async () => {
    const gate = deferred<boolean>();
    const plugin = fakePlugin({ isPermissionGranted: vi.fn(() => gate.promise) });
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });

    const first = adapter.ensurePermission();
    const second = adapter.ensurePermission();
    gate.resolve(true);

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(plugin.isPermissionGranted).toHaveBeenCalledTimes(1);
  });

  it('sends a silent warning notification built only from the task and lead label', async () => {
    const plugin = fakePlugin({ isPermissionGranted: vi.fn(async () => true) });
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });
    await adapter.ensurePermission();

    await adapter.notifyWarning('Write the report', '30 seconds');

    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    const [payload] = plugin.sendNotification.mock.calls[0];
    expect(payload.body).toContain('Write the report');
    expect(payload.title).toContain('30 seconds');
    expect(payload.silent).toBe(true);
    expect(payload).not.toHaveProperty('sound');
  });

  it('sends a silent completion notification containing the task and nothing else user-authored', async () => {
    const plugin = fakePlugin({ isPermissionGranted: vi.fn(async () => true) });
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });
    await adapter.ensurePermission();

    await adapter.notifyCompletion('Write the report');

    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    const [payload] = plugin.sendNotification.mock.calls[0];
    expect(payload.body).toContain('Write the report');
    expect(payload.silent).toBe(true);
  });

  it('sends a silent intermission-return notification with the kind and task', async () => {
    const plugin = fakePlugin({ isPermissionGranted: vi.fn(async () => true) });
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });
    await adapter.ensurePermission();

    await adapter.notifyIntermissionReturn('touchGrass', 'Write the report');

    expect(plugin.sendNotification).toHaveBeenCalledWith({
      title: 'Touch Grass time is up',
      body: 'Write the report',
      silent: true,
    });
  });

  it('never sends and never prompts when permission has not been ensured as granted', async () => {
    const plugin = fakePlugin(); // isPermissionGranted resolves false by default
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });

    await adapter.notifyWarning('Task', '30 seconds');
    await adapter.notifyCompletion('Task');
    await adapter.notifyIntermissionReturn('break', 'Task');

    expect(plugin.sendNotification).not.toHaveBeenCalled();
    expect(plugin.requestPermission).not.toHaveBeenCalled(); // notify* never itself prompts
  });

  it('resolves without throwing when the send itself fails, and logs it', async () => {
    const plugin = fakePlugin({
      isPermissionGranted: vi.fn(async () => true),
      sendNotification: vi.fn(() => {
        throw new Error('plugin unavailable');
      }),
    });
    const logError = vi.fn();
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
      logError,
    });
    await adapter.ensurePermission();

    await expect(adapter.notifyWarning('Task', '30 seconds')).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });

  it('resolves without throwing when the permission check itself fails, and logs it', async () => {
    const plugin = fakePlugin({
      isPermissionGranted: vi.fn(async () => {
        throw new Error('plugin unavailable');
      }),
    });
    const logError = vi.fn();
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
      logError,
    });

    await expect(adapter.ensurePermission()).resolves.toBe(false);
    expect(logError).toHaveBeenCalled();
  });

  it('defaults to logging failures via console.error, not a silent no-op', async () => {
    const plugin = fakePlugin({
      isPermissionGranted: vi.fn(async () => {
        throw new Error('plugin unavailable');
      }),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const adapter = createNativeNotificationAdapter({
        isTauriFn: () => true,
        loadNotificationPlugin: async () => plugin,
      });

      await adapter.ensurePermission();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('dispose() invalidates a late-resolving permission check', async () => {
    const gate = deferred<boolean>();
    const plugin = fakePlugin({ isPermissionGranted: vi.fn(() => gate.promise) });
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });

    const pending = adapter.ensurePermission();
    await adapter.dispose();
    gate.resolve(true);

    expect(await pending).toBe(false); // disposed before it resolved
  });

  it('dispose() prevents a send from actually being requested once its permission lookup resolves late', async () => {
    const gate = deferred<boolean>();
    const plugin = fakePlugin({ isPermissionGranted: vi.fn(() => gate.promise) });
    const adapter = createNativeNotificationAdapter({
      isTauriFn: () => true,
      loadNotificationPlugin: async () => plugin,
    });

    const pending = adapter.ensurePermission();
    await adapter.dispose();
    gate.resolve(true);
    await pending;

    await adapter.notifyWarning('Task', '30 seconds'); // disposed — must not send
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});
