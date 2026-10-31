import { reportHttpFailure } from "../reporting/report.ts";

/** The browser's calls to the REST API. Same-origin JSON, as the server requires. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  }
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    reportHttpFailure(init.method ?? "GET", path, response.status, json.error);
    throw new ApiError(json.error ?? "Something went wrong. Please try again.", response.status);
  }
  return json as T;
}

/** Downsize a photo on the device: a phone's 12 MP original is wasted on "the broken bit". */
export async function downsizePhoto(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap === "undefined") return file;
  const MAX = 2000;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 2_000_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export async function uploadAttachment(taskId: string, file: File): Promise<void> {
  const body = await downsizePhoto(file);
  let response: Response;
  try {
    response = await fetch(`/api/v1/tasks/${taskId}/attachments?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": body.type || "application/octet-stream" },
      body,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  }
  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { error?: string };
    reportHttpFailure("POST", `/api/v1/tasks/${taskId}/attachments`, response.status, json.error);
    throw new ApiError(json.error ?? "The upload failed.", response.status);
  }
}

/** A screenshot, shrunk on the device like any photo. */
export async function uploadFeedbackImage(feedbackId: string, file: File): Promise<void> {
  const body = await downsizePhoto(file);
  const response = await fetch(`/api/v1/feedback/${feedbackId}/images`, {
    method: "POST",
    headers: { "Content-Type": body.type || "application/octet-stream" },
    body,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { error?: string };
    reportHttpFailure("POST", `/api/v1/feedback/${feedbackId}/images`, response.status, json.error);
    throw new ApiError(json.error ?? "The upload failed.", response.status);
  }
}
