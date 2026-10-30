import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

import type { Actor } from "./actors.ts";
import { config } from "./config.server.ts";
import { UserInputError } from "./errors.ts";
import { ATTACHMENT_MAX_BYTES } from "./limits.ts";
import { type AttachmentView, type WriteContext, addAttachment, assertCanAttach, readableAttachment, removeAttachment } from "./tasks.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * Attachment bytes on disk. Stored by id with no extension; the row in
 * `attachments` says what they are, and every read goes through the app and
 * inherits the task's visibility.
 *
 * The type is sniffed from the bytes. What the uploader claimed is ignored,
 * since that claim decides whether a browser renders it inline. SVG never counts
 * as an image here: it's a document that can run script.
 */

/** Served inline. Everything else is a download, whatever it says it is. */
const INLINE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const THUMB_SIZE = 480;

export function sniffType(bytes: Uint8Array): string {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  return "application/octet-stream";
}

export function cleanFilename(raw: string | null | undefined): string {
  // Path separators are dropped rather than trusted; this name is only ever a label.
  // eslint-disable-next-line no-control-regex
  const name = (raw ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").trim();
  return name.slice(-200) || "attachment";
}

function storedPath(id: string, variant: "original" | "thumb"): string {
  return join(config.attachmentsDir, variant === "thumb" ? `${id}.thumb` : id);
}

/**
 * Re-encoding is what drops EXIF (and GPS with it): sharp keeps no metadata
 * unless told to. .rotate() applies the orientation it's about to lose.
 */
async function makeThumb(bytes: Uint8Array): Promise<{ thumb: Buffer; width: number | null; height: number | null } | null> {
  try {
    const image = sharp(bytes, { failOn: "error" });
    const meta = await image.metadata();
    const thumb = await image.rotate().resize(THUMB_SIZE, THUMB_SIZE, { fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    return { thumb, width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return null;
  }
}

/** Read a request's body, stopping at the limit rather than after it. */
async function readLimited(request: Request): Promise<Uint8Array> {
  const tooLarge = () => new UserInputError("That file is over the 25 MB limit.");
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (declared > ATTACHMENT_MAX_BYTES) throw tooLarge();
  if (!request.body) throw new UserInputError("There's no file in that upload.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ATTACHMENT_MAX_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  if (size === 0) throw new UserInputError("That file is empty.");
  return new Uint8Array(Buffer.concat(chunks));
}

/** Take an upload. The body is the file; the name comes separately. */
export async function storeUpload(actor: Actor, taskId: string, request: Request, filename: string | null, ctx: WriteContext = {}): Promise<AttachmentView> {
  // Checked before reading: a refused upload shouldn't cost 25 MB of memory.
  assertCanAttach(actor, taskId);
  const bytes = await readLimited(request);
  const id = uuidv7();
  let mime = sniffType(bytes);
  let width: number | null = null;
  let height: number | null = null;
  let hasThumb = false;

  mkdirSync(config.attachmentsDir, { recursive: true });
  if (INLINE_TYPES.has(mime)) {
    const made = await makeThumb(bytes);
    if (made) {
      await Bun.write(storedPath(id, "thumb"), made.thumb);
      width = made.width;
      height = made.height;
      hasThumb = true;
    } else {
      // It says it's an image and no decoder agrees, so it won't be shown as one.
      mime = "application/octet-stream";
    }
  }
  await Bun.write(storedPath(id, "original"), bytes);

  try {
    return addAttachment(
      actor,
      taskId,
      { id, filename: cleanFilename(filename), mime, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), width, height, hasThumb },
      ctx,
    );
  } catch (err) {
    // Refused at the last moment (visibility changed mid-upload): leave no orphan bytes.
    rmSync(storedPath(id, "original"), { force: true });
    rmSync(storedPath(id, "thumb"), { force: true });
    throw err;
  }
}

/** RFC 6266: an ASCII fallback, and the real name percent-encoded. */
function dispositionName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Headers every attachment response gets, inline or not. */
function safetyHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    // If anything ever does render as a document, it renders as nothing.
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

/** The file, after the visibility check. Unknown and unseeable look the same. */
export function serveAttachment(actor: Actor, id: string): Response {
  const a = readableAttachment(actor, id);
  const inline = INLINE_TYPES.has(a.mime);
  return new Response(Bun.file(storedPath(id, "original")).stream(), {
    headers: {
      ...safetyHeaders(),
      "Content-Type": inline ? a.mime : "application/octet-stream",
      "Content-Length": String(a.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; ${dispositionName(a.filename)}`,
    },
  });
}

export function serveThumb(actor: Actor, id: string): Response {
  const a = readableAttachment(actor, id);
  if (!a.hasThumb) return new Response("Not found", { status: 404, headers: safetyHeaders() });
  return new Response(Bun.file(storedPath(id, "thumb")).stream(), {
    headers: { ...safetyHeaders(), "Content-Type": "image/webp", "Content-Disposition": "inline" },
  });
}

/** Removed means removed: the history keeps its name, and the bytes go. */
export function deleteUpload(actor: Actor, id: string, ctx: WriteContext = {}): void {
  removeAttachment(actor, id, ctx);
  rmSync(storedPath(id, "original"), { force: true });
  rmSync(storedPath(id, "thumb"), { force: true });
}
