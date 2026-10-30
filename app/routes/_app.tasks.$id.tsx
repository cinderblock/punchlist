import { Alert, Anchor, Badge, Button, Card, FileButton, Group, Image, SimpleGrid, Stack, Text, Textarea, Timeline, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { Link, data, useNavigate, useOutletContext, useRevalidator } from "react-router";

import { DomainError } from "../../src/errors.ts";
import { COMMENT_MAX_LENGTH } from "../../src/limits.ts";
import { daysBetween, formatDate, formatInstant } from "../../src/time.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { requireViewer } from "../auth.server.ts";
import { LockIcon, PinIcon, RepeatIcon } from "../components/icons.tsx";
import { SiteMap } from "../components/site-map.tsx";
import { pageTitle } from "../meta.ts";
import { checkQueue } from "../offline/check-queue.ts";
import { ApiError, api, uploadAttachment } from "../tasks/api.ts";
import { TaskForm } from "../tasks/TaskForm.tsx";
import { taskPageData } from "../tasks.server.ts";
import type { AppContext } from "./_app.tsx";
import type { Route } from "./+types/_app.tasks.$id";

export function loader({ request, context, params }: Route.LoaderArgs) {
  const actor = requireViewer(context, request);
  try {
    return taskPageData(actor, params.id);
  } catch (err) {
    if (err instanceof DomainError) throw data(err.message, { status: err.status });
    throw err;
  }
}

export function meta({ matches, loaderData }: Route.MetaArgs) {
  return pageTitle(matches, loaderData?.task.title ?? "Task");
}

const EVENT_TEXT: Record<string, string> = {
  created: "added this",
  updated: "changed this",
  completed: "checked this off",
  reopened: "reopened this",
  deleted: "deleted this",
  commented: "commented",
  attached: "attached a file",
  detached: "removed a file",
  deduped: "reported this again",
  superseded: "took this back",
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function TaskPage({ loaderData }: Route.ComponentProps) {
  const { task, comments, attachments, history, today, timezone, maps } = loaderData;
  const { me } = useOutletContext<AppContext>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = task.status === "done";
  const overdue = !done && task.dueDate != null && daysBetween(today, task.dueDate) < 0;
  const map = maps.find((m) => m.id === task.location?.mapId);
  const point = task.location?.x != null && task.location.y != null ? { x: task.location.x, y: task.location.y } : null;

  const fail = (err: unknown) => {
    setBusy(false);
    notifications.show({ color: "red", message: err instanceof ApiError ? err.message : "That didn't save." });
  };

  async function toggle() {
    const queue = checkQueue();
    queue.add({ id: uuidv7(), taskId: task.id, action: done ? "reopen" : "complete", title: task.title, at: Date.now() });
    await queue.flush();
    await revalidator.revalidate();
  }

  async function remove() {
    if (!window.confirm(`Delete "${task.title}"?`)) return;
    try {
      await api(`/api/v1/tasks/${task.id}`, { method: "DELETE" });
      navigate("/");
    } catch (err) {
      fail(err);
    }
  }

  if (editing) {
    return (
      <Stack maw={640} mx="auto" gap="md">
        <Title order={1} size="h2">
          Edit task
        </Title>
        <TaskForm
          task={task}
          options={loaderData}
          rights={{ assign: task.can.assign, share: task.can.manageAccess, visibility: task.can.manageAccess || task.can.makePrivate, recurrence: me.kind === "user" }}
          saveLabel="Save"
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(payload) => {
            setBusy(true);
            api(`/api/v1/tasks/${task.id}`, { method: "PATCH", body: { ...payload, expectedRev: task.rev } })
              .then(() => revalidator.revalidate())
              .then(() => {
                setBusy(false);
                setEditing(false);
              })
              .catch(fail);
          }}
        />
      </Stack>
    );
  }

  return (
    <Stack maw={720} mx="auto" gap="lg">
      <Stack gap={6}>
        <Group justify="space-between" align="start" wrap="nowrap">
          <Title order={1} size="h2" td={done ? "line-through" : undefined}>
            {task.title}
          </Title>
          {done && (
            <Badge color="green" variant="light" flex="none">
              Done
            </Badge>
          )}
        </Group>
        <Group gap="sm">
          {task.dueDate && (
            <Text c={overdue ? "red" : "dimmed"} fw={overdue ? 600 : 400}>
              {overdue ? "Overdue: " : "Due "}
              {formatDate(task.dueDate, today)}
            </Text>
          )}
          {task.visibility === "private" && (
            <Group gap={4} c="dimmed">
              <LockIcon />
              <Text c="dimmed">Private</Text>
            </Group>
          )}
          {task.recurrence && (
            <Group gap={4} c="dimmed">
              <RepeatIcon />
              <Text c="dimmed">Repeats {task.recurrence.text}</Text>
            </Group>
          )}
          {task.labels.map((l) => (
            <Badge key={l.id} variant="light" color={l.color ?? "gray"} tt="none">
              {l.name}
            </Badge>
          ))}
        </Group>
      </Stack>

      <Group gap="xs">
        {task.can.complete && (
          <Button size="lg" variant={done ? "default" : "filled"} onClick={() => void toggle()}>
            {done ? "Reopen" : "Check off"}
          </Button>
        )}
        {task.can.edit && (
          <Button variant="default" size="lg" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {task.can.delete && (
          <Button variant="subtle" color="red" size="lg" onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </Group>
      {me.kind !== "user" && !task.can.edit && (
        <Text size="sm" c="dimmed">
          <Anchor component={Link} to={`/signin?next=${encodeURIComponent(`/tasks/${task.id}`)}`}>
            Sign in
          </Anchor>{" "}
          to edit or delete this.
        </Text>
      )}

      {task.details && <Text style={{ whiteSpace: "pre-wrap" }}>{task.details}</Text>}

      {task.location && (
        <Stack gap="xs">
          <Group gap={4} c="dimmed">
            <PinIcon />
            <Text>{[task.location.zoneName, task.location.note].filter(Boolean).join(", ") || task.location.mapName}</Text>
          </Group>
          {map && point && <SiteMap map={map} selected={point} highlightZone={task.location.zoneId} />}
        </Stack>
      )}

      <Group gap="xl">
        {task.assignees.length > 0 && <Fact label="Assigned to" value={task.assignees.map((a) => a.name).join(", ")} />}
        {task.sharedWith.length > 0 && <Fact label="Shared with" value={task.sharedWith.map((a) => a.name).join(", ")} />}
        <Fact label="Added by" value={task.createdBy} />
        {task.completedBy && task.completedAt && <Fact label="Checked off by" value={`${task.completedBy}, ${formatInstant(task.completedAt, timezone, today)}`} />}
      </Group>

      <Attachments taskId={task.id} attachments={attachments} canAttach={task.can.attach} onChange={() => void revalidator.revalidate()} />

      <Stack gap="sm">
        <Title order={2} size="h4">
          Comments
        </Title>
        {comments.length === 0 && (
          <Text c="dimmed" size="sm">
            No comments yet.
          </Text>
        )}
        {comments.map((c) => (
          <Card key={c.id} withBorder padding="sm">
            <Text size="sm" c="dimmed">
              {c.actor}, {c.when}
            </Text>
            <Text style={{ whiteSpace: "pre-wrap" }}>{c.body}</Text>
          </Card>
        ))}
        {task.can.comment && <AddComment taskId={task.id} onAdded={() => void revalidator.revalidate()} />}
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h4">
          History
        </Title>
        <Timeline bulletSize={12} lineWidth={2}>
          {history.map((e) => (
            <Timeline.Item key={e.id} title={`${e.actor} ${EVENT_TEXT[e.type] ?? e.type}`}>
              <Text size="xs" c="dimmed">
                {e.when} via {e.via}
              </Text>
            </Timeline.Item>
          ))}
        </Timeline>
      </Stack>
    </Stack>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </div>
  );
}

function AddComment({ taskId, onAdded }: { taskId: string; onAdded: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        const id = uuidv7();
        api(`/api/v1/tasks/${taskId}/comments`, { method: "POST", body: { id, body }, idempotencyKey: id })
          .then(() => {
            setBody("");
            onAdded();
          })
          .catch((err: unknown) => notifications.show({ color: "red", message: err instanceof ApiError ? err.message : "That didn't save." }))
          .finally(() => setBusy(false));
      }}
    >
      <Stack gap="xs">
        <Textarea aria-label="Add a comment" placeholder="Add a comment" autosize minRows={2} maxLength={COMMENT_MAX_LENGTH} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
        <Group>
          <Button type="submit" variant="light" loading={busy} disabled={!body.trim()}>
            Comment
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function Attachments({
  taskId,
  attachments,
  canAttach,
  onChange,
}: {
  taskId: string;
  attachments: Route.ComponentProps["loaderData"]["attachments"];
  canAttach: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function upload(files: File[]) {
    setBusy(true);
    setProblem(null);
    try {
      for (const file of files) await uploadAttachment(taskId, file);
      onChange();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/v1/attachments/${id}`, { method: "DELETE" });
      onChange();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "That didn't work.");
    }
  }

  if (attachments.length === 0 && !canAttach) return null;
  return (
    <Stack gap="sm">
      <Title order={2} size="h4">
        Attachments
      </Title>
      {attachments.length === 0 && (
        <Text c="dimmed" size="sm">
          No photos or files yet.
        </Text>
      )}
      {attachments.length > 0 && (
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
          {attachments.map((a) => (
            <Card key={a.id} withBorder padding="xs">
              <a href={`/attachments/${a.id}`} target="_blank" rel="noreferrer" aria-label={`Open ${a.filename}`}>
                {a.hasThumb ? <Image src={`/attachments/${a.id}/thumb`} alt={a.filename} radius="sm" h={120} fit="cover" /> : <Text fw={500}>{a.filename}</Text>}
              </a>
              <Text size="xs" c="dimmed" truncate>
                {a.filename}, {formatBytes(a.size)}
              </Text>
              {a.canDelete && (
                <Button size="compact-xs" variant="subtle" color="red" onClick={() => void remove(a.id)}>
                  Remove
                </Button>
              )}
            </Card>
          ))}
        </SimpleGrid>
      )}
      {canAttach && (
        <Group>
          <FileButton multiple accept="image/*,application/pdf,text/plain" onChange={(files) => void upload(files)}>
            {(props) => (
              <Button {...props} variant="light" loading={busy}>
                Add a photo or file
              </Button>
            )}
          </FileButton>
        </Group>
      )}
      {problem && (
        <Alert color="red" role="alert">
          {problem}
        </Alert>
      )}
    </Stack>
  );
}
