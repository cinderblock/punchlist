import { Anchor, Button, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { addDays } from "../../src/time.ts";
import type { TaskView } from "../../src/tasks.ts";
import { uuidv7 } from "../../src/uuid.ts";
import { checkQueue, usePendingChecks } from "../offline/check-queue.ts";
import { TaskRow } from "./TaskRow.tsx";

/** How long a checked-off row stays where it was, so the next tap lands where it's aimed. */
const HOLD_MS = 5000;
/** Past this, a due date goes in Later rather than cluttering the working list. */
const SOON_DAYS = 14;

interface Group {
  key: string;
  title: string;
  tasks: TaskView[];
}

export function groupTasks(tasks: readonly TaskView[], today: string): Group[] {
  const soon = addDays(today, SOON_DAYS);
  const groups: Record<string, TaskView[]> = { overdue: [], today: [], soon: [], undated: [], later: [] };
  for (const t of tasks) {
    if (!t.dueDate) groups.undated!.push(t);
    else if (t.dueDate < today) groups.overdue!.push(t);
    else if (t.dueDate === today) groups.today!.push(t);
    else if (t.dueDate <= soon) groups.soon!.push(t);
    else groups.later!.push(t);
  }
  const named: [string, string][] = [
    ["overdue", "Overdue"],
    ["today", "Today"],
    ["soon", "Coming up"],
    ["undated", "Any time"],
    ["later", "Later"],
  ];
  return named.flatMap(([key, title]) => (groups[key]!.length > 0 ? [{ key, title, tasks: groups[key]! }] : []));
}

/**
 * The list, with optimistic check-off. A tap goes into the device's queue at once
 * and the row answers immediately; the server hears as soon as it can. A checked
 * row is held in place for a few seconds whatever the server says, and offers Undo.
 */
export function TaskList({ tasks, today, view }: { tasks: readonly TaskView[]; today: string; view: "open" | "done" }) {
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  const pending = usePendingChecks();

  /** Rows checked here in the last moments, kept visible until they've had their time. */
  const [held, setHeld] = useState<Map<string, { task: TaskView; done: boolean }>>(new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running.values()) clearTimeout(timer);
    };
  }, []);

  const toggle = useCallback((task: TaskView, done: boolean) => {
    const queue = checkQueue();
    queue.add({ id: uuidv7(), taskId: task.id, action: done ? "complete" : "reopen", title: task.title, at: Date.now() });
    setHeld((prev) => new Map(prev).set(task.id, { task, done }));
    clearTimeout(timers.current.get(task.id));
    timers.current.set(
      task.id,
      setTimeout(() => {
        setHeld((prev) => {
          const next = new Map(prev);
          next.delete(task.id);
          return next;
        });
      }, HOLD_MS),
    );
    void queue.flush().then(() => revalidate.current());

    if (done) {
      const id = `undo-${task.id}`;
      notifications.show({
        id,
        message: (
          <Text size="sm" component="span">
            Checked off. <Anchor component="button" type="button" size="sm" fw={600} onClick={() => {
              notifications.hide(id);
              toggle(task, false);
            }}>Undo</Anchor>
          </Text>
        ),
        autoClose: HOLD_MS,
      });
    }
  }, []);

  const rows = useMemo(() => {
    const ids = new Set(tasks.map((t) => t.id));
    return [...tasks, ...[...held.values()].filter((h) => !ids.has(h.task.id)).map((h) => h.task)];
  }, [tasks, held]);

  const isDone = (task: TaskView) => {
    const queued = pending.filter((p) => p.taskId === task.id).pop();
    if (queued) return queued.action === "complete";
    return held.get(task.id)?.done ?? task.status === "done";
  };

  if (view === "done") {
    return (
      <Stack gap={0}>
        {rows.map((t) => (
          <TaskRow key={t.id} task={t} today={today} done={isDone(t)} onToggle={toggle} />
        ))}
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      {groupTasks(rows, today).map((group) => (
        <section key={group.key} aria-label={group.title}>
          <Title order={2} size="sm" c={group.key === "overdue" ? "red" : "dimmed"} tt="uppercase" mb={4}>
            {group.title}
          </Title>
          <div>
            {group.tasks.map((t) => (
              <TaskRow key={t.id} task={t} today={today} done={isDone(t)} onToggle={toggle} />
            ))}
          </div>
        </section>
      ))}
    </Stack>
  );
}

/** Real empty states: what's true, and the next thing to do. */
export function EmptyList({ filtered, view, onClear }: { filtered: boolean; view: "open" | "done"; onClear: () => void }) {
  if (filtered) {
    return (
      <Stack align="center" gap="xs" py="xl">
        <Title order={2} size="h4">
          Nothing matches
        </Title>
        <Text c="dimmed" ta="center">
          No tasks fit those filters.
        </Text>
        <Button variant="light" onClick={onClear}>
          Clear filters
        </Button>
      </Stack>
    );
  }
  return (
    <Stack align="center" gap="xs" py="xl">
      <Title order={2} size="h4">
        {view === "done" ? "Nothing checked off yet" : "All clear"}
      </Title>
      <Text c="dimmed" ta="center">
        {view === "done" ? "Finished tasks show up here." : "Nothing needs doing right now. Spotted something? Add it above."}
      </Text>
    </Stack>
  );
}
