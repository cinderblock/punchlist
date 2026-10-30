/**
 * The domain layer's way of saying "there's something new to look at", without
 * importing the notifier (which reads tasks, which would be a cycle). The worker
 * installs the hook; with no worker running, and in tests, it does nothing.
 */
type GlobalWithKick = typeof globalThis & { __punchlistNotifierKick__?: () => void };

export function requestNotifierPass(): void {
  (globalThis as GlobalWithKick).__punchlistNotifierKick__?.();
}

export function installNotifierKick(kick: (() => void) | undefined): void {
  (globalThis as GlobalWithKick).__punchlistNotifierKick__ = kick;
}
