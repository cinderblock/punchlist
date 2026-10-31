import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";
import { z } from "zod";

import { type Actor, actorId, actorLabel } from "./actors.ts";
import { readLimited, safetyHeaders, sniffType } from "./attachment-store.ts";
import { audit } from "./audit.ts";
import { config } from "./config.server.ts";
import { db } from "./db.server.ts";
import { type ClientContext, INBOX_URL, cleanContext, clientContextSchema, countOpenErrors } from "./error-reports.ts";
import { ConflictError, ForbiddenError, NotFoundError, UserInputError } from "./errors.ts";
import { FEEDBACK_KINDS, FEEDBACK_KIND_LABELS, FEEDBACK_STATUSES, type FeedbackKind, type FeedbackStatus } from "./feedback-kinds.ts";
import { FEEDBACK_IMAGES_MAX, FEEDBACK_IMAGE_MAX_BYTES, FEEDBACK_MAX_LENGTH } from "./limits.ts";
import { requestNotifierPass } from "./notifications/kick.ts";
import { enqueueForAdmins } from "./notifications/store.ts";
import { canAttachToFeedback, canSendFeedback, canTriageReports } from "./permissions.ts";
import { checkFeedbackRate } from "./rate-limit.ts";
import { describeUserAgent } from "./user-agent.ts";
import { UUID_PATTERN, uuidv7 } from "./uuid.ts";

/**
 * What people tell the admins from inside the app. The person typed it and has been
 * told who reads it, so the words are kept as they are. What's added around them is a
 * path and a device, redacted like an error's.
 */

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Plenty to read a screen by. Anything bigger is a photo of something else. */
const IMAGE_MAX_SIDE = 2000;
/** A screenshot comes straight after its note, or not at all. */
const IMAGE_WINDOW_MS = 10 * 60_000;

const feedbackSchema = z.object({
  id: z.string().regex(UUID_PATTERN).optional(),
  kind: z.enum(FEEDBACK_KINDS),
  body: z.string().trim().min(1, "Say what happened first.").max(FEEDBACK_MAX_LENGTH, "That's too long. Could you shorten it?"),
  context: clientContextSchema,
  relatedErrors: z.array(z.number().int().positive()).max(10).default([]),
});

interface FeedbackRow {
  id: string;
  kind: FeedbackKind;
  body: string;
  status: FeedbackStatus;
  actor_id: string;
  actor_label: string;
  path: string | null;
  user_agent: string | null;
  context: string | null;
  related_errors: string;
  created_at: number;
}

export interface FeedbackView {
  id: string;
  kind: FeedbackKind;
  body: string;
  status: FeedbackStatus;
  who: string;
  path: string | null;
  device: string | null;
  userAgent: string | null;
  context: ClientContext | null;
  relatedErrors: number[];
  images: string[];
  createdAt: number;
}

function imagesOf(feedbackId: string): string[] {
  return db().query<{ id: string }, [string]>("SELECT id FROM feedback_images WHERE feedback_id = ? ORDER BY created_at, id").all(feedbackId).map((r) => r.id);
}

const toView = (r: FeedbackRow): FeedbackView => ({
  id: r.id,
  kind: r.kind,
  body: r.body,
  status: r.status,
  who: r.actor_label,
  path: r.path,
  device: r.user_agent ? describeUserAgent(r.user_agent) : null,
  userAgent: r.user_agent,
  context: r.context ? (JSON.parse(r.context) as ClientContext) : null,
  relatedErrors: JSON.parse(r.related_errors) as number[],
  images: imagesOf(r.id),
  createdAt: r.created_at,
});

/** Take a note. Sending the same id again, as an outbox might, answers with the first. */
export function sendFeedback(actor: Actor, body: unknown, userAgent: string | null, now: number = Date.now()): { id: string } {
  if (!canSendFeedback(actor)) throw new ForbiddenError("Feedback comes from people.");
  checkFeedbackRate(actor, now);
  const input = feedbackSchema.parse(body);
  const context = cleanContext(input.context);
  const id = input.id ?? uuidv7();
  const who = actorId(actor);

  const added = db()
    .query(
      `INSERT INTO feedback (id, kind, body, actor_id, actor_label, path, user_agent, context, related_errors, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, input.kind, input.body, who, actorLabel(actor), context.path ?? null, userAgent?.slice(0, 300) ?? null, JSON.stringify(context), JSON.stringify(input.relatedErrors), now, now);
  if (added.changes === 0) {
    const first = db().query<{ actor_id: string }, [string]>("SELECT actor_id FROM feedback WHERE id = ?").get(id);
    if (first?.actor_id !== who) throw new ConflictError("That note can't be sent again.");
    return { id };
  }

  const queued = enqueueForAdmins({ key: `feedback:${id}`, title: `${FEEDBACK_KIND_LABELS[input.kind]}: ${actorLabel(actor)}`, body: input.body.slice(0, 200), url: INBOX_URL, now });
  if (queued) requestNotifierPass();
  return { id };
}

function imagePath(id: string): string {
  return join(config.attachmentsDir, "feedback", id);
}

/**
 * Add a screenshot to a note just sent by this person. Only ever the re-encoded copy is
 * written: that's what drops EXIF, and with it where a photo was taken.
 */
export async function addFeedbackImage(actor: Actor, feedbackId: string, request: Request, now: number = Date.now()): Promise<{ id: string }> {
  if (!canAttachToFeedback(actor)) throw new ForbiddenError("Sign in to attach a screenshot.");
  const row = db().query<{ actor_id: string; created_at: number }, [string]>("SELECT actor_id, created_at FROM feedback WHERE id = ?").get(feedbackId);
  if (!row || row.actor_id !== actorId(actor)) throw new NotFoundError("That note doesn't exist.");
  if (now - row.created_at > IMAGE_WINDOW_MS) throw new ConflictError("That note has already gone in.");
  const count = () => imagesOf(feedbackId).length;
  // Before reading: a refused upload shouldn't cost 10 MB of memory.
  if (count() >= FEEDBACK_IMAGES_MAX) throw new UserInputError(`${FEEDBACK_IMAGES_MAX} screenshots is the limit.`);

  const bytes = await readLimited(request, FEEDBACK_IMAGE_MAX_BYTES);
  if (!IMAGE_TYPES.has(sniffType(bytes))) throw new UserInputError("That doesn't look like a screenshot. Try a PNG or JPEG.");
  let encoded: { data: Buffer; info: { width: number; height: number; size: number } };
  try {
    encoded = await sharp(bytes, { failOn: "error" })
      .rotate()
      .resize(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new UserInputError("That image couldn't be read.");
  }

  const id = uuidv7();
  mkdirSync(join(config.attachmentsDir, "feedback"), { recursive: true });
  await Bun.write(imagePath(id), encoded.data);
  // Checked again after the wait: two uploads at once could both have passed above.
  const stored = db().transaction(() => {
    if (count() >= FEEDBACK_IMAGES_MAX) return false;
    db()
      .query("INSERT INTO feedback_images (id, feedback_id, size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, feedbackId, encoded.info.size, encoded.info.width, encoded.info.height, now);
    return true;
  })();
  if (!stored) {
    rmSync(imagePath(id), { force: true });
    throw new UserInputError(`${FEEDBACK_IMAGES_MAX} screenshots is the limit.`);
  }
  return { id };
}

// ---- the inbox ---------------------------------------------------------------------------

function assertCanTriage(actor: Actor): void {
  if (!canTriageReports(actor)) throw new ForbiddenError("This is for admins.");
}

/** Newest first. Anyone else gets the same answer as for an image that isn't there. */
export function serveFeedbackImage(actor: Actor, id: string): Response {
  if (!canTriageReports(actor)) throw new NotFoundError("That image doesn't exist.");
  const row = db().query<{ size: number }, [string]>("SELECT size FROM feedback_images WHERE id = ?").get(id);
  if (!row) throw new NotFoundError("That image doesn't exist.");
  return new Response(Bun.file(imagePath(id)).stream(), {
    headers: { ...safetyHeaders(), "Content-Type": "image/webp", "Content-Length": String(row.size), "Content-Disposition": "inline" },
  });
}

export function listFeedback(actor: Actor, filter: { open?: boolean; limit?: number } = {}): FeedbackView[] {
  assertCanTriage(actor);
  const where = filter.open ? "WHERE status = 'new'" : "";
  return db()
    .query<FeedbackRow, [number]>(`SELECT * FROM feedback ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(filter.limit ?? 200)
    .map(toView);
}

export function setFeedbackStatus(actor: Extract<Actor, { kind: "user" }>, id: string, status: string, now: number = Date.now()): void {
  assertCanTriage(actor);
  const next = z.enum(FEEDBACK_STATUSES).parse(status);
  const row = db().query<{ status: string }, [string]>("SELECT status FROM feedback WHERE id = ?").get(id);
  if (!row) throw new NotFoundError("That note has gone.");
  db().query("UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?").run(next, now, id);
  audit({ actorUserId: actor.userId, entity: "feedback", entityId: id, action: "status", before: { status: row.status }, after: { status: next }, at: now });
}

/** Spam, or something typed that shouldn't be kept. Its screenshots go with it. */
export function deleteFeedback(actor: Extract<Actor, { kind: "user" }>, id: string): void {
  assertCanTriage(actor);
  const row = db().query<{ kind: string; actor_label: string }, [string]>("SELECT kind, actor_label FROM feedback WHERE id = ?").get(id);
  if (!row) throw new NotFoundError("That note has gone.");
  const images = imagesOf(id);
  db().query("DELETE FROM feedback WHERE id = ?").run(id);
  for (const image of images) rmSync(imagePath(image), { force: true });
  audit({ actorUserId: actor.userId, entity: "feedback", entityId: id, action: "delete", before: { kind: row.kind, from: row.actor_label } });
}

/** The inbox's badge. For the nav, which every admin page loads. */
export function countOpenReports(): number {
  const { n } = db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'").get()!;
  return n + countOpenErrors();
}
