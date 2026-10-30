import { Stack, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router";

import { uuidv7 } from "../../src/uuid.ts";
import { requireViewer } from "../auth.server.ts";
import { pageTitle } from "../meta.ts";
import { ApiError, api } from "../tasks/api.ts";
import { TaskForm } from "../tasks/TaskForm.tsx";
import { referenceData } from "../tasks.server.ts";
import type { AppContext } from "./_app.tsx";
import type { Route } from "./+types/_app.tasks.new";

export function loader({ request, context }: Route.LoaderArgs) {
  return referenceData(requireViewer(context, request));
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "New task");
}

export default function NewTask({ loaderData }: Route.ComponentProps) {
  const { me } = useOutletContext<AppContext>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const signedIn = me.kind === "user";

  return (
    <Stack maw={640} mx="auto" gap="md">
      <Title order={1} size="h2">
        New task
      </Title>
      <TaskForm
        task={null}
        initialTitle={params.get("title") ?? ""}
        options={loaderData}
        rights={{ assign: signedIn, share: signedIn, visibility: signedIn, recurrence: signedIn }}
        saveLabel="Add task"
        busy={busy}
        onCancel={() => navigate("/")}
        onSave={(payload) => {
          setBusy(true);
          const id = uuidv7();
          api("/api/v1/tasks", { method: "POST", body: { id, ...payload, location: payload.location ?? undefined, recurrence: payload.recurrence ?? undefined }, idempotencyKey: id })
            .then(() => navigate("/"))
            .catch((err: unknown) => {
              setBusy(false);
              notifications.show({ color: "red", message: err instanceof ApiError ? err.message : "That didn't save." });
            });
        }}
      />
    </Stack>
  );
}
