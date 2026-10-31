import { Alert, Anchor, Badge, Button, Card, Code, Group, Image, NativeSelect, SimpleGrid, Stack, Switch, Tabs, Text, Title } from "@mantine/core";
import { useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";

import { userActor } from "../../src/actors.ts";
import { type ClientContext, type ErrorGroupView, listErrorGroups, setErrorStatus } from "../../src/error-reports.ts";
import { type FeedbackView, deleteFeedback, listFeedback, setFeedbackStatus } from "../../src/feedback.ts";
import { ERROR_STATUSES, ERROR_STATUS_LABELS, FEEDBACK_KIND_LABELS, FEEDBACK_STATUSES, FEEDBACK_STATUS_LABELS } from "../../src/feedback-kinds.ts";
import { handleForm, intField, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import { whenText } from "../views.server.ts";
import type { Route } from "./+types/_app.admin.feedback";

/**
 * Everything people and the app itself have told the admins. Nothing here shows a
 * task: a report holds someone's own words and a path, so being an admin still opens
 * no side door into private tasks.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireAdmin(context, request);
  const actor = userActor(user);
  const open = new URL(request.url).searchParams.get("all") !== "1";
  return {
    notes: listFeedback(actor, { open }).map((n) => ({ ...n, when: whenText(n.createdAt) })),
    errors: listErrorGroups(actor, { open }).map((e) => ({ ...e, first: whenText(e.firstAt), last: whenText(e.lastAt) })),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Feedback");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  const actor = userActor(user);
  return handleForm(request, {
    "feedback-status": (form) => {
      setFeedbackStatus(actor, stringField(form, "id"), stringField(form, "status"));
      return { ok: true };
    },
    "feedback-delete": (form) => {
      deleteFeedback(actor, stringField(form, "id"));
      return { ok: true, message: "Deleted." };
    },
    "error-status": (form) => {
      setErrorStatus(actor, intField(form, "id"), stringField(form, "status"));
      return { ok: true };
    },
  });
}

export default function Feedback({ loaderData }: Route.ComponentProps) {
  const { notes, errors } = loaderData;
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "errors" ? "errors" : "notes";
  const all = params.get("all") === "1";

  const change = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        if (value == null) prev.delete(key);
        else prev.set(key, value);
        return prev;
      },
      { replace: true, preventScrollReset: true },
    );

  return (
    <Stack gap="md" maw={900} mx="auto">
      <Title order={1} size="h2">
        Feedback
      </Title>
      <Group justify="space-between" align="center">
        <Tabs value={tab} onChange={(value) => change("tab", value === "errors" ? "errors" : null)}>
          <Tabs.List>
            <Tabs.Tab value="notes">Notes ({notes.length})</Tabs.Tab>
            <Tabs.Tab value="errors">Errors ({errors.length})</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <Switch label="Show finished" checked={all} onChange={(e) => change("all", e.currentTarget.checked ? "1" : null)} />
      </Group>

      {tab === "notes" ? (
        notes.length === 0 ? (
          <Text c="dimmed">Nothing here.</Text>
        ) : (
          notes.map((n) => <NoteCard key={n.id} note={n} />)
        )
      ) : (
        <>
          <Alert color="gray">Grouped by what went wrong, newest first. One that's marked fixed reopens by itself if it happens again.</Alert>
          {errors.length === 0 ? <Text c="dimmed">Nothing here.</Text> : errors.map((e) => <ErrorCard key={e.id} error={e} />)}
        </>
      )}
    </Stack>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Text size="sm">
      <Text span c="dimmed">
        {label}:{" "}
      </Text>
      {children}
    </Text>
  );
}

/** How to get back to where it happened. */
function Context({ path, device, userAgent, context }: { path: string | null; device: string | null; userAgent: string | null; context: ClientContext | null }) {
  const flags = [context?.viewport, context?.standalone ? "installed" : null, context?.colorScheme, context?.online === false ? "offline" : null].filter(Boolean);
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={4} verticalSpacing={4}>
      {path && (
        <Fact label="Page">
          <Anchor component={Link} to={path}>
            {path}
          </Anchor>
        </Fact>
      )}
      {device && (
        <Fact label="Device">
          <span title={userAgent ?? undefined}>{device}</span>
          {flags.length > 0 && ` (${flags.join(", ")})`}
        </Fact>
      )}
      {context?.trail && context.trail.length > 1 && <Fact label="Before that">{context.trail.slice(0, -1).join(" → ")}</Fact>}
      {context?.revision && <Fact label="Version">{context.revision.slice(0, 12)}</Fact>}
    </SimpleGrid>
  );
}

function StatusSelect({ intent, id, value, labels, statuses }: { intent: string; id: string | number; value: string; labels: Record<string, string>; statuses: readonly string[] }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const shown = fetcher.formData ? String(fetcher.formData.get("status")) : value;
  return (
    <NativeSelect
      aria-label="Status"
      size="sm"
      w={120}
      style={{ flex: "none" }}
      value={shown}
      data={statuses.map((s) => ({ value: s, label: labels[s]! }))}
      onChange={(e) => fetcher.submit({ intent, id: String(id), status: e.currentTarget.value }, { method: "post" })}
    />
  );
}

function NoteCard({ note }: { note: FeedbackView & { when: string } }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const [confirming, setConfirming] = useState(false);
  return (
    <Card withBorder data-testid="feedback-note">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="start">
          <Group gap="xs">
            <Badge variant="light">{FEEDBACK_KIND_LABELS[note.kind]}</Badge>
            <Text size="sm" fw={500}>
              {note.who}
            </Text>
            <Text size="sm" c="dimmed">
              {note.when}
            </Text>
          </Group>
          <StatusSelect intent="feedback-status" id={note.id} value={note.status} labels={FEEDBACK_STATUS_LABELS} statuses={FEEDBACK_STATUSES} />
        </Group>
        <Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{note.body}</Text>
        {note.images.length > 0 && (
          <Group gap="xs">
            {note.images.map((id) => (
              <Anchor key={id} href={`/api/v1/feedback/images/${id}`} target="_blank" rel="noreferrer">
                <Image src={`/api/v1/feedback/images/${id}`} alt="A screenshot sent with this note" h={140} w="auto" radius="sm" />
              </Anchor>
            ))}
          </Group>
        )}
        <Context path={note.path} device={note.device} userAgent={note.userAgent} context={note.context} />
        {note.relatedErrors.length > 0 && <Fact label="Errors just before">{note.relatedErrors.map((id) => `#${id}`).join(", ")}</Fact>}
        <Group justify="flex-end">
          {confirming ? (
            <>
              <Button size="compact-sm" variant="subtle" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
              <Button size="compact-sm" color="red" loading={fetcher.state !== "idle"} onClick={() => fetcher.submit({ intent: "feedback-delete", id: note.id }, { method: "post" })}>
                Delete for good
              </Button>
            </>
          ) : (
            <Button size="compact-sm" variant="subtle" color="red" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

function ErrorCard({ error }: { error: ErrorGroupView & { first: string; last: string } }) {
  return (
    <Card withBorder id={`error-${error.id}`} data-testid="error-group">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="start">
          <Group gap="xs">
            <Badge variant="light" color="red">
              #{error.id}
            </Badge>
            <Badge variant="default">{error.source}</Badge>
            <Badge variant="default">{error.count === 1 ? "Once" : `${error.count} times`}</Badge>
            {error.anonymous && (
              <Badge color="yellow" variant="light" title="This came with no sign-in, so anyone on the internet could have written it.">
                Signed out, unverified
              </Badge>
            )}
          </Group>
          <StatusSelect intent="error-status" id={error.id} value={error.status} labels={ERROR_STATUS_LABELS} statuses={ERROR_STATUSES} />
        </Group>
        <Text ff="monospace" size="sm" style={{ overflowWrap: "anywhere" }}>
          {error.name}: {error.message}
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={4} verticalSpacing={4}>
          <Fact label="Last">{error.last}</Fact>
          <Fact label="First">{error.first}</Fact>
          {error.who && <Fact label="Last seen by">{error.who}</Fact>}
          {error.lastRevision && error.lastRevision !== error.firstRevision && <Fact label="First in version">{error.firstRevision?.slice(0, 12) ?? "unknown"}</Fact>}
        </SimpleGrid>
        <Context path={error.path} device={error.device} userAgent={error.userAgent} context={error.context} />
        {error.stack && (
          <details>
            <summary style={{ cursor: "pointer" }}>Stack</summary>
            <Code block mt="xs" style={{ overflowX: "auto" }}>
              {error.stack}
            </Code>
          </details>
        )}
      </Stack>
    </Card>
  );
}
