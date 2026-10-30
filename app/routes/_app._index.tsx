import { ActionIcon, Button, Chip, Group, ScrollArea, SegmentedControl, Select, Stack, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";
import { Link, useOutletContext, useRevalidator, useSearchParams } from "react-router";

import { TITLE_MAX_LENGTH } from "../../src/limits.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { requireViewer } from "../auth.server.ts";
import { LockIcon, PlusIcon } from "../components/icons.tsx";
import { pageTitle } from "../meta.ts";
import { isOfflineError, readCopy, writeCopy } from "../offline/copies.ts";
import { ApiError, api } from "../tasks/api.ts";
import { EmptyList, TaskList } from "../tasks/TaskList.tsx";
import { indexData } from "../tasks.server.ts";
import type { AppContext } from "./_app.tsx";
import type { Route } from "./+types/_app._index";

export function loader({ request, context }: Route.LoaderArgs) {
  return indexData(requireViewer(context, request), new URL(request.url));
}

/** The last list this device saw stands in when the server can't be reached. */
export async function clientLoader({ request, serverLoader }: Route.ClientLoaderArgs) {
  const key = `list:${new URL(request.url).search}`;
  try {
    const fresh = await serverLoader();
    writeCopy(key, fresh);
    return fresh;
  } catch (err) {
    const copy = isOfflineError(err) ? (readCopy<Awaited<ReturnType<typeof loader>>>(key) ?? readCopy<Awaited<ReturnType<typeof loader>>>("list:")) : null;
    if (copy) return copy;
    throw err;
  }
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Tasks");
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const { tasks, query, labels, zones, today } = loaderData;
  const { me } = useOutletContext<AppContext>();
  const [params, setParams] = useSearchParams();
  const filtered = Boolean(query.q || query.label || query.zone || query.mine);

  const set = (name: string, value: string | null) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  return (
    <Stack gap="sm" maw={760} mx="auto">
      <QuickAdd signedIn={me.kind === "user"} />

      <Group gap="xs" wrap="nowrap">
        <SegmentedControl
          aria-label="Which tasks"
          value={query.view}
          onChange={(v) => set("view", v === "done" ? "done" : null)}
          data={[
            { value: "open", label: "Open" },
            { value: "done", label: "Done" },
          ]}
        />
        <SearchBox value={query.q} onChange={(v) => set("q", v || null)} />
      </Group>

      {(labels.length > 0 || zones.length > 0 || me.kind === "user") && (
        <ScrollArea type="never" offsetScrollbars={false}>
          <Group gap={6} wrap="nowrap" pb={2}>
            {me.kind === "user" && (
              <Chip size="sm" checked={query.mine} onChange={() => set("mine", query.mine ? null : "1")}>
                Mine
              </Chip>
            )}
            {zones.length > 0 && (
              <Select
                size="xs"
                w={140}
                flex="none"
                aria-label="Zone"
                placeholder="Any zone"
                clearable
                value={query.zone || null}
                onChange={(v) => set("zone", v)}
                data={zones.map((z) => ({ value: z.id, label: z.name }))}
              />
            )}
            {labels.map((l) => (
              <Chip key={l.id} size="sm" checked={query.label === l.name} onChange={() => set("label", query.label === l.name ? null : l.name)}>
                {l.name}
              </Chip>
            ))}
          </Group>
        </ScrollArea>
      )}

      {tasks.length === 0 ? <EmptyList filtered={filtered} view={query.view} onClear={() => setParams({}, { replace: true })} /> : <TaskList tasks={tasks} today={today} view={query.view} />}
    </Stack>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => latest.current(text), 250);
    return () => clearTimeout(timer);
  }, [text, value]);
  return <TextInput style={{ flex: 1 }} type="search" aria-label="Search tasks" placeholder="Search" value={text} onChange={(e) => setText(e.currentTarget.value)} />;
}

/** Add a task in one line, which is how most tasks get added. */
function QuickAdd({ signedIn }: { signedIn: boolean }) {
  const revalidator = useRevalidator();
  const [title, setTitle] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (!text) return;
    setBusy(true);
    const id = uuidv7();
    try {
      await api("/api/v1/tasks", { method: "POST", body: { id, title: text, visibility: isPrivate ? "private" : "public" }, idempotencyKey: id });
      setTitle("");
      await revalidator.revalidate();
    } catch (err) {
      notifications.show({ color: "red", message: err instanceof ApiError ? err.message : "That didn't save." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={add}>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          size="md"
          aria-label="New task"
          placeholder="What needs doing?"
          maxLength={TITLE_MAX_LENGTH}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        {signedIn && (
          <Tooltip label={isPrivate ? "Private: only you" : "Public: everyone here"}>
            <ActionIcon size={42} variant={isPrivate ? "filled" : "default"} aria-label="Private" aria-pressed={isPrivate} onClick={() => setPrivate(!isPrivate)}>
              <LockIcon size={18} />
            </ActionIcon>
          </Tooltip>
        )}
        <Button type="submit" loading={busy} disabled={!title.trim()} aria-label="Add task" px="sm">
          <PlusIcon size={20} />
        </Button>
      </Group>
      <Button component={Link} to={title ? `/tasks/new?title=${encodeURIComponent(title)}` : "/tasks/new"} variant="subtle" size="compact-sm" mt={4} >
        More options
      </Button>
    </form>
  );
}
