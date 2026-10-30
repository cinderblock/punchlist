import { Avatar, Badge, Group, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { Link } from "react-router";

import { daysBetween, formatDue } from "../../src/time.ts";
import type { TaskView } from "../../src/tasks.ts";
import { CheckIcon, ClipIcon, CommentIcon, LockIcon, PinIcon, RepeatIcon } from "../components/icons.tsx";
import classes from "./task-row.module.css";

const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** One row. The whole left edge is the check-off: it's used with cold hands and gloves. */
export function TaskRow({ task, today, done, onToggle }: { task: TaskView; today: string; done: boolean; onToggle: (task: TaskView, done: boolean) => void }) {
  const overdue = !done && task.dueDate != null && daysBetween(today, task.dueDate) < 0;
  const dueToday = !done && task.dueDate === today;

  return (
    <div className={classes.row} data-done={done || undefined} data-testid="task-row">
      {task.can.complete ? (
        <UnstyledButton
          className={classes.check}
          role="checkbox"
          aria-checked={done}
          aria-label={`${done ? "Reopen" : "Check off"} ${task.title}`}
          onClick={() => onToggle(task, !done)}
        >
          <span className={classes.circle}>{done && <CheckIcon size={18} />}</span>
        </UnstyledButton>
      ) : (
        <span className={classes.check} />
      )}
      <Link to={`/tasks/${task.id}`} className={classes.body} prefetch="intent">
        <Text fw={500} className={classes.title} lineClamp={2}>
          {task.title}
        </Text>
        <Group gap={8} mt={2} wrap="wrap">
          {task.dueDate && (
            <Text size="sm" c={overdue ? "red" : dueToday ? "brand" : "dimmed"} fw={overdue || dueToday ? 600 : 400}>
              {overdue ? "Overdue: " : ""}
              {formatDue(task.dueDate, today)}
            </Text>
          )}
          {task.location && (task.location.zoneName || task.location.note) && (
            <Group gap={2} wrap="nowrap" c="dimmed">
              <PinIcon size={14} />
              <Text size="sm" c="dimmed" truncate>
                {task.location.zoneName ?? task.location.note}
              </Text>
            </Group>
          )}
          {task.visibility === "private" && (
            <Group gap={2} wrap="nowrap" c="dimmed">
              <LockIcon size={14} title="Private" />
              <Text size="sm" c="dimmed">
                Private
              </Text>
            </Group>
          )}
          {task.recurrence && (
            <Group c="dimmed">
              <RepeatIcon size={14} title={`Repeats ${task.recurrence.text}`} />
            </Group>
          )}
          {task.commentCount > 0 && (
            <Group gap={2} wrap="nowrap" c="dimmed">
              <CommentIcon size={14} title="Comments" />
              <Text size="sm" c="dimmed">
                {task.commentCount}
              </Text>
            </Group>
          )}
          {task.attachmentCount > 0 && (
            <Group gap={2} wrap="nowrap" c="dimmed">
              <ClipIcon size={14} title="Attachments" />
              <Text size="sm" c="dimmed">
                {task.attachmentCount}
              </Text>
            </Group>
          )}
          {task.labels.map((l) => (
            <Badge key={l.id} size="sm" variant="light" color={l.color ?? "gray"} tt="none">
              {l.name}
            </Badge>
          ))}
        </Group>
      </Link>
      {task.assignees.length > 0 && (
        <Avatar.Group spacing="xs" className={classes.people}>
          {task.assignees.slice(0, 3).map((a) => (
            <Tooltip key={a.id} label={a.name}>
              <Avatar size={30} radius="xl" color="brand" aria-label={`Assigned to ${a.name}`}>
                {initials(a.name)}
              </Avatar>
            </Tooltip>
          ))}
        </Avatar.Group>
      )}
    </div>
  );
}
