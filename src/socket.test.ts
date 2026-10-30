import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSocket, prepareSocket, socketIsLive } from "./socket.ts";

const unixOnly = process.platform === "win32" ? test.skip : test;

let dir: string;
let path: string;
let server: Server | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "punchlist-socket-"));
  path = join(dir, "run", "app.sock");
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

const listen = (p: string) =>
  new Promise<Server>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(p, () => resolve(s));
  });

describe("preparing a socket path", () => {
  test("makes the directory", async () => {
    await prepareSocket(path);
    expect(statSync(join(dir, "run")).isDirectory()).toBe(true);
  });

  test("refuses to replace something that isn't a socket", async () => {
    await prepareSocket(path);
    writeFileSync(path, "precious");
    await expect(prepareSocket(path)).rejects.toThrow(/isn't a socket/);
    expect(existsSync(path)).toBe(true);
  });

  unixOnly("refuses a socket something is listening on, and leaves it alone", async () => {
    await prepareSocket(path);
    server = await listen(path);
    expect(await socketIsLive(path)).toBe(true);
    await expect(prepareSocket(path)).rejects.toThrow(/already listening/);
    expect(existsSync(path)).toBe(true);
  });

  unixOnly("removes a stale socket nothing is listening on", async () => {
    await prepareSocket(path);
    // Closing a listener normally unlinks it, so make a stale one the way a crash does.
    const child = Bun.spawn(["bun", "-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`]);
    await child.exited;
    expect(existsSync(path)).toBe(true);
    expect(lstatSync(path).isSocket()).toBe(true);
    expect(await socketIsLive(path)).toBe(false);
    await prepareSocket(path);
    expect(existsSync(path)).toBe(false);
  });

  unixOnly("finding 15: a directory the app makes is 0750", async () => {
    const previous = process.umask(0o022);
    await prepareSocket(path);
    process.umask(previous);
    expect(statSync(join(dir, "run")).mode & 0o777).toBe(0o750);
  });

  unixOnly("finding 15: a shared directory that already exists is left as it is, and the socket stays connectable", async () => {
    const shared = join(dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o770);
    const inShared = join(shared, "app.sock");
    await prepareSocket(inShared);
    expect(statSync(shared).mode & 0o777).toBe(0o770);
    server = await listen(inShared);
    openSocket(inShared);
    expect(statSync(inShared).mode & 0o777).toBe(0o666);
    expect(await socketIsLive(inShared)).toBe(true);
  });

  unixOnly("after binding, other users can connect", async () => {
    await prepareSocket(path);
    server = await listen(path);
    openSocket(path);
    expect(statSync(path).mode & 0o777).toBe(0o666);
  });
});
