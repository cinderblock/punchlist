import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";

/**
 * Listening on a unix socket. Two things a TCP port doesn't need:
 *
 *   A socket file outlives the process that made it, so a crash leaves a stale
 *   one that makes the next bind fail. It's removed, but only once we know
 *   nothing is listening: unlinking a live socket would silently orphan a
 *   running server, which goes on looking healthy with no way to reach it.
 *
 *   A socket is created with this process's umask, and the reverse proxy runs
 *   as another user, so it's opened up after binding. What actually keeps other
 *   users out is the directory it lives in, which only the proxy shares.
 */

/** True if something accepts a connection on this path right now. */
export function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = connect({ path });
    const finish = (live: boolean) => {
      client.removeAllListeners();
      client.destroy();
      resolve(live);
    };
    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
    setTimeout(() => finish(false), 1000).unref?.();
  });
}

/** Get ready to bind `path`: make its directory, clear a stale file, refuse a live one. */
export async function prepareSocket(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) return;
  if (!lstatSync(path).isSocket()) {
    throw new Error(`SOCKET_PATH ${path} exists and isn't a socket; refusing to replace it.`);
  }
  if (await socketIsLive(path)) {
    throw new Error(`Something is already listening on ${path}.`);
  }
  unlinkSync(path);
}

/** After binding: let the reverse proxy, which runs as another user, connect. */
export function openSocket(path: string): void {
  chmodSync(path, 0o666);
}

export function removeSocket(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone. Nothing depends on this: the next start clears it anyway.
  }
}
