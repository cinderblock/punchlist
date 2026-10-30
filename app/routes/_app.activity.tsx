import { Anchor, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router";

import { requireViewer } from "../auth.server.ts";
import { pageTitle } from "../meta.ts";
import { activityData } from "../tasks.server.ts";
import type { Route } from "./+types/_app.activity";

export function loader({ request, context }: Route.LoaderArgs) {
  return activityData(requireViewer(context, request));
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Activity");
}

const VERBS: Record<string, string> = {
  created: "added",
  updated: "changed",
  completed: "checked off",
  reopened: "reopened",
  commented: "commented on",
  attached: "attached a file to",
  detached: "removed a file from",
  deduped: "reported again:",
};

/** Who did what, across every task the viewer can see. Private tasks they can't see leave no trace here. */
export default function Activity({ loaderData }: Route.ComponentProps) {
  const events = loaderData.events.filter((e) => e.type !== "superseded");
  return (
    <Stack maw={720} mx="auto" gap="md">
      <Title order={1} size="h2">
        Activity
      </Title>
      {events.length === 0 && <Text c="dimmed">Nothing has happened here yet.</Text>}
      <Stack gap="xs">
        {events.map((e) => (
          <div key={e.id}>
            <Text>
              {e.actor} {VERBS[e.type] ?? e.type}{" "}
              <Anchor component={Link} to={`/tasks/${e.taskId}`}>
                {e.taskTitle}
              </Anchor>
            </Text>
            <Text size="xs" c="dimmed">
              {e.when} via {e.via}
            </Text>
          </div>
        ))}
      </Stack>
    </Stack>
  );
}
