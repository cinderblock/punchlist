/**
 * What someone can say, and what becomes of it. Shared by the server's validation and
 * the browser's forms, so like limits.ts it must stay dependency-free.
 */
export const FEEDBACK_KINDS = ["bug", "confusing", "idea", "polish"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** In the words of the person choosing one. */
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  bug: "Something's broken",
  confusing: "Confusing",
  idea: "An idea",
  polish: "Looks off",
};

export const FEEDBACK_STATUSES = ["new", "planned", "done", "declined"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: "New",
  planned: "Planned",
  done: "Done",
  declined: "Won't do",
};

export const ERROR_STATUSES = ["open", "resolved", "ignored"] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

export const ERROR_STATUS_LABELS: Record<ErrorStatus, string> = {
  open: "Open",
  resolved: "Fixed",
  ignored: "Ignored",
};

/** Where in the browser an error surfaced. The server prefixes these, so a client can't claim to be it. */
export const CLIENT_ERROR_SOURCES = ["window", "promise", "react", "router", "api", "passkey", "worker"] as const;
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];
