import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { cleanFilename, deleteUpload, serveAttachment, serveThumb, sniffType, storeUpload } from "./attachment-store.ts";
import { config, setConfigForTests } from "./config.server.ts";
import { ForbiddenError, UserInputError } from "./errors.ts";
import { ATTACHMENT_MAX_BYTES } from "./limits.ts";
import { createTask, getTask, listAttachments, removeAttachment, taskHistory } from "./tasks.ts";
import { type World, ORIGIN, agentFor, freshWorld } from "./testing/fixtures.ts";

let w: World;
let dir: string;
let taskId: string;

beforeEach(() => {
  w = freshWorld();
  dir = mkdtempSync(join(tmpdir(), "punchlist-attachments-"));
  config.attachmentsDir = dir;
  taskId = createTask(w.alice, { title: "With a photo" }).task.id;
});

afterEach(() => {
  setConfigForTests(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const upload = (bytes: Uint8Array | Buffer, type = "application/octet-stream") => new Request(`${ORIGIN}/x`, { method: "POST", headers: { "Content-Type": type }, body: new Blob([new Uint8Array(bytes)]) });

const jpegWithExif = () =>
  sharp({ create: { width: 800, height: 600, channels: 3, background: "#808080" } })
    .withExif({ IFD3: { GPSLatitude: "51/1 30/1 0/1" }, IFD0: { Make: "SecretCameraMaker" } })
    .jpeg()
    .toBuffer();

describe("storing", () => {
  test("a photo gets a thumbnail, and the thumbnail has no EXIF", async () => {
    const photo = await jpegWithExif();
    expect(photo.includes(Buffer.from("SecretCameraMaker"))).toBe(true);

    const view = await storeUpload(w.alice, taskId, upload(photo, "image/jpeg"), "photo.jpg");
    expect(view).toMatchObject({ mime: "image/jpeg", width: 800, height: 600, hasThumb: true, filename: "photo.jpg" });

    const thumb = Buffer.from(await serveThumb(w.alice, view.id).arrayBuffer());
    expect(thumb.includes(Buffer.from("SecretCameraMaker"))).toBe(false);
    const meta = await sharp(thumb).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(480);
  });

  test("stored by id, with no extension, so nothing on disk is named by the uploader", async () => {
    const view = await storeUpload(w.alice, taskId, upload(await jpegWithExif()), "../../evil.php");
    expect(readdirSync(dir).sort()).toEqual([view.id, `${view.id}.thumb`].sort());
    expect(view.filename).toBe("evil.php");
  });

  test("adds an event and counts on the task", async () => {
    await storeUpload(w.alice, taskId, upload(Buffer.from("plain text file")), "notes.txt");
    expect(taskHistory(w.alice, taskId).map((e) => e.type)).toEqual(["created", "attached"]);
    expect(getTask(w.alice, taskId).attachmentCount).toBe(1);
  });

  test("the claimed type is ignored: an HTML file calling itself a PNG is a download", async () => {
    const view = await storeUpload(w.alice, taskId, upload(Buffer.from("<script>alert(1)</script>"), "image/png"), "x.png");
    expect(view.mime).toBe("application/octet-stream");
    const response = serveAttachment(w.alice, view.id);
    expect(response.headers.get("Content-Disposition")).toStartWith("attachment;");
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  test("SVG is never an image here, whatever it calls itself", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const view = await storeUpload(w.alice, taskId, upload(svg, "image/svg+xml"), "logo.svg");
    expect(view.hasThumb).toBe(false);
    expect(serveAttachment(w.alice, view.id).headers.get("Content-Disposition")).toStartWith("attachment;");
  });

  test("something with an image's magic bytes that no decoder agrees with isn't shown as one", async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("not a jpeg at all")]);
    const view = await storeUpload(w.alice, taskId, upload(fake, "image/jpeg"), "fake.jpg");
    expect(view.hasThumb).toBe(false);
    expect(view.mime).toBe("application/octet-stream");
  });

  test("over the limit is refused", async () => {
    const big = new Request(`${ORIGIN}/x`, { method: "POST", headers: { "Content-Length": String(ATTACHMENT_MAX_BYTES + 1) }, body: "x" });
    await expect(storeUpload(w.alice, taskId, big, "big.bin")).rejects.toThrow(/25 MB/);
    await expect(storeUpload(w.alice, taskId, upload(new Uint8Array(ATTACHMENT_MAX_BYTES + 1)), "big.bin")).rejects.toThrow(/25 MB/);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("empty is refused", async () => {
    await expect(storeUpload(w.alice, taskId, upload(new Uint8Array(0)), "empty")).rejects.toThrow(UserInputError);
  });
});

describe("who may", () => {
  test("an on-site visitor can't attach", async () => {
    const stream = upload(Buffer.from("x"));
    await expect(storeUpload(w.lan, taskId, stream, "x")).rejects.toThrow(ForbiddenError);
  });

  test("an agent needs the scope", async () => {
    await expect(storeUpload(agentFor(w.alice, ["tasks:read", "tasks:write"]).actor, taskId, upload(Buffer.from("x")), "x")).rejects.toThrow(ForbiddenError);
    const view = await storeUpload(agentFor(w.alice, ["tasks:read", "attachments:write"]).actor, taskId, upload(Buffer.from("x")), "x");
    expect(view.by).toBe("Helper, for Alice Member");
  });

  test("the uploader, the task's owner or an admin can remove one; removed means gone", async () => {
    const view = await storeUpload(w.bob, taskId, upload(Buffer.from("x")), "x");
    const other = createTask(w.bob, { title: "Bob's" }).task.id;
    const second = await storeUpload(w.alice, other, upload(Buffer.from("y")), "y");
    expect(() => removeAttachment(w.lan, view.id)).toThrow(ForbiddenError);
    deleteUpload(w.alice, view.id);
    expect(listAttachments(w.alice, taskId)).toEqual([]);
    expect(readdirSync(dir)).not.toContain(view.id);
    expect(() => serveAttachment(w.alice, view.id)).toThrow(/doesn't exist/);
    removeAttachment(w.bob, second.id);
  });
});

test("what's inline is an allowlist", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).png().toBuffer();
  expect(sniffType(new Uint8Array(png))).toBe("image/png");
  expect(sniffType(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
  expect(sniffType(new TextEncoder().encode("<html>"))).toBe("application/octet-stream");
});

test("filenames lose paths and control characters", () => {
  expect(cleanFilename("C:\\Users\\me\\photo.jpg")).toBe("photo.jpg");
  expect(cleanFilename("a\u0000b\r\nc.txt")).toBe("abc.txt");
  expect(cleanFilename("")).toBe("attachment");
  expect(cleanFilename(null)).toBe("attachment");
  expect(existsSync(dir)).toBe(true);
});
