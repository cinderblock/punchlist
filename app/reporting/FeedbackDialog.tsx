import { Button, FileButton, Group, Modal, SegmentedControl, Stack, Text, Textarea } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";

import { FEEDBACK_KINDS, FEEDBACK_KIND_LABELS, type FeedbackKind } from "../../src/feedback-kinds.ts";
import { FEEDBACK_IMAGES_MAX, FEEDBACK_MAX_LENGTH } from "../../src/limits.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { readCopy, writeCopy } from "../offline/copies.ts";
import { ApiError, api, uploadFeedbackImage } from "../tasks/api.ts";
import { currentContext, queueFeedback, recentErrorIds, reportsSent } from "./report.ts";

const DRAFT = "feedback-draft";

/**
 * Say something to the admins, from wherever you are. It's a dialog rather than a page
 * so that opening it can't lose what's half typed behind it, and the words here stay
 * if it's closed by accident.
 */
export function FeedbackDialog({ opened, onClose, signedIn }: { opened: boolean; onClose: () => void; signedIn: boolean }) {
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fullScreen = useMediaQuery("(max-width: 48em)");

  // Most pages can't survive losing the connection, and this dialog goes with them.
  // What's typed is kept with the pages' own copies, which leave when the person does.
  useEffect(() => {
    const draft = readCopy<{ kind: FeedbackKind; body: string }>(DRAFT);
    if (!draft) return;
    setKind(draft.kind);
    setBody(draft.body);
  }, []);
  const remember = (next: { kind: FeedbackKind; body: string }) => {
    setKind(next.kind);
    setBody(next.body);
    writeCopy(DRAFT, next);
  };

  const done = (message: string, color = "green") => {
    remember({ kind: "bug", body: "" });
    setImages([]);
    setProblem(null);
    onClose();
    notifications.show({ message, color });
  };

  const send = async () => {
    setBusy(true);
    setProblem(null);
    await reportsSent();
    const note = { id: uuidv7(), kind, body, context: currentContext(), relatedErrors: recentErrorIds() };
    try {
      await api("/api/v1/feedback", { method: "POST", body: note });
    } catch (err) {
      setBusy(false);
      if (!(err instanceof ApiError) || err.status !== 0) {
        setProblem(err instanceof ApiError ? err.message : "That didn't send. Please try again.");
      } else if (images.length > 0) {
        setProblem("Can't reach the server, and a screenshot can't wait on this device. Try again with a connection, or remove the screenshot and it'll send when you're back.");
      } else {
        queueFeedback(note);
        done("Saved on this device. It'll send when you're back online.");
      }
      return;
    }

    try {
      for (const image of images) await uploadFeedbackImage(note.id, image);
      done("Thanks. That's gone to the admins.");
    } catch {
      done("Your note was sent, but a screenshot wasn't.", "yellow");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Send feedback" fullScreen={fullScreen}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Stack gap="md">
          <SegmentedControl
            fullWidth
            orientation={fullScreen ? "vertical" : "horizontal"}
            aria-label="What kind of feedback"
            value={kind}
            onChange={(value) => remember({ kind: value as FeedbackKind, body })}
            data={FEEDBACK_KINDS.map((k) => ({ value: k, label: FEEDBACK_KIND_LABELS[k] }))}
          />
          <Textarea size="md" label="What happened?" required autosize minRows={4} maxRows={12} maxLength={FEEDBACK_MAX_LENGTH} value={body} onChange={(e) => remember({ kind, body: e.currentTarget.value })} data-autofocus />
          {signedIn && (
            <Group gap="sm">
              <FileButton multiple accept="image/png,image/jpeg,image/webp" onChange={(files) => setImages(files.slice(0, FEEDBACK_IMAGES_MAX))}>
                {(props) => (
                  <Button {...props} variant="default" size="sm">
                    {images.length > 0 ? "Choose different screenshots" : "Add a screenshot"}
                  </Button>
                )}
              </FileButton>
              {images.length > 0 && (
                <Text size="sm" c="dimmed" data-testid="feedback-images">
                  {images.length === 1 ? images[0]!.name : `${images.length} screenshots`}
                </Text>
              )}
            </Group>
          )}
          <Text size="sm" c="dimmed">
            The admins read this. They'll see {signedIn ? "your name, " : ""}the page you're on and what kind of device it is, but nothing else on your screen.
          </Text>
          {problem && (
            <Text size="sm" c="red" role="alert">
              {problem}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="subtle" onClick={onClose}>
              Not now
            </Button>
            <Button type="submit" loading={busy} disabled={!body.trim()}>
              Send
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
