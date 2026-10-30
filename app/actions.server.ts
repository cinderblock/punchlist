import { ZodError } from "zod";

import { DomainError } from "../src/errors.ts";
import { assertSameOrigin } from "../src/http/guard.ts";

/** What a form action answers. */
export type ActionResult = { ok: true; message?: string; [key: string]: unknown } | { ok: false; error: string };

type Handler = (form: FormData) => ActionResult | Promise<ActionResult>;

/**
 * Run a form action: refuse anything not from our own pages, pick the handler by
 * the form's `intent`, and turn a refusal into a message the page can show.
 */
export async function handleForm(request: Request, handlers: Record<string, Handler>): Promise<ActionResult> {
  assertSameOrigin(request);
  const form = await request.formData();
  const handler = handlers[String(form.get("intent") ?? "")];
  if (!handler) return { ok: false, error: "That isn't something this page does." };
  try {
    return await handler(form);
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, error: err.message };
    if (err instanceof ZodError) return { ok: false, error: err.issues[0]?.message ?? "That didn't look right." };
    throw err;
  }
}

export function stringField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export function intField(form: FormData, name: string): number {
  const value = Number(stringField(form, name));
  if (!Number.isInteger(value)) throw new DomainError("That didn't look right.", 400);
  return value;
}
