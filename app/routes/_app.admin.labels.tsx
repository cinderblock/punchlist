import { Button, Card, ColorInput, Group, Stack, Text, TextInput, Title } from "@mantine/core";
import { useFetcher } from "react-router";

import { userActor } from "../../src/actors.ts";
import { LABEL_MAX_LENGTH } from "../../src/limits.ts";
import { archiveLabel, createLabel, listLabels, updateLabel } from "../../src/tasks.ts";
import { handleForm, intField, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import type { Route } from "./+types/_app.admin.labels";

export function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireAdmin(context, request);
  return { labels: listLabels(userActor(user)) };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Labels");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  const actor = userActor(user);
  return handleForm(request, {
    create: (form) => {
      const label = createLabel(actor, { name: stringField(form, "name"), color: stringField(form, "color") || null });
      return { ok: true, message: `Added ${label.name}.` };
    },
    update: (form) => {
      updateLabel(actor, intField(form, "id"), { name: stringField(form, "name"), color: stringField(form, "color") || null });
      return { ok: true, message: "Saved." };
    },
    archive: (form) => {
      archiveLabel(actor, intField(form, "id"));
      return { ok: true, message: "Archived. Tasks keep it, and it's no longer offered." };
    },
  });
}

export default function Labels({ loaderData }: Route.ComponentProps) {
  const add = useFetcher();
  useActionFeedback(add.data);
  return (
    <Stack gap="lg" maw={640} mx="auto">
      <Stack gap={4}>
        <Title order={1} size="h2">
          Labels
        </Title>
        <Text size="sm" c="dimmed">
          The config file seeds these once. After that they're yours to change here.
        </Text>
      </Stack>
      {loaderData.labels.length === 0 && <Text c="dimmed">No labels yet.</Text>}
      <Stack gap="xs">
        {loaderData.labels.map((l) => (
          <LabelRow key={l.id} label={l} />
        ))}
      </Stack>
      <Card withBorder>
        <add.Form method="post">
          <input type="hidden" name="intent" value="create" />
          <Group align="end">
            <TextInput name="name" label="New label" required maxLength={LABEL_MAX_LENGTH} style={{ flex: 1 }} />
            <ColorInput name="color" label="Colour" format="hex" w={130} />
            <Button type="submit" loading={add.state !== "idle"}>
              Add
            </Button>
          </Group>
        </add.Form>
      </Card>
    </Stack>
  );
}

function LabelRow({ label }: { label: { id: number; name: string; color: string | null } }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="id" value={label.id} />
      <Group align="end" gap="xs" wrap="nowrap">
        <TextInput name="name" aria-label="Label name" defaultValue={label.name} required maxLength={LABEL_MAX_LENGTH} style={{ flex: 1 }} />
        <ColorInput name="color" aria-label="Colour" format="hex" defaultValue={label.color ?? ""} w={120} />
        <Button type="submit" name="intent" value="update" variant="light" size="sm">
          Save
        </Button>
        <Button type="submit" name="intent" value="archive" variant="subtle" color="red" size="sm">
          Archive
        </Button>
      </Group>
    </fetcher.Form>
  );
}
