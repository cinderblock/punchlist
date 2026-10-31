import { useState } from "react";

import { FEEDBACK_MAX_LENGTH } from "../../src/limits.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { ApiError, api } from "../tasks/api.ts";
import { currentContext, recentErrorIds } from "./report.ts";

type State = "idle" | "sending" | "sent" | "signed-out" | "failed";

/**
 * Add a word to an error that's already been reported. This renders in place of the
 * app, so with no theme around it, and it has to work when the rest doesn't.
 */
export function ErrorNote() {
  const [body, setBody] = useState("");
  const [state, setState] = useState<State>("idle");

  const send = async () => {
    setState("sending");
    try {
      await api("/api/v1/feedback", { method: "POST", body: { id: uuidv7(), kind: "bug", body, context: currentContext(), relatedErrors: recentErrorIds() } });
      setState("sent");
    } catch (err) {
      setState(err instanceof ApiError && err.status === 401 ? "signed-out" : "failed");
    }
  };

  if (state === "sent") return <p role="status">Thanks. That's gone to the admins.</p>;
  if (state === "signed-out") return <p role="status">The error has been reported. Sign in to send a note with it.</p>;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label htmlFor="error-note" style={{ display: "block", marginBottom: "0.25rem" }}>
        This has been reported. What were you doing? (optional)
      </label>
      <textarea
        id="error-note"
        rows={3}
        maxLength={FEEDBACK_MAX_LENGTH}
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        style={{ display: "block", width: "100%", boxSizing: "border-box", font: "inherit", fontSize: "16px", padding: "0.5rem" }}
      />
      <button type="submit" disabled={!body.trim() || state === "sending"} style={{ marginTop: "0.5rem", font: "inherit", padding: "0.4rem 1rem" }}>
        Send
      </button>
      {state === "failed" && <p role="alert">That didn't send. The error itself was still reported.</p>}
    </form>
  );
}
