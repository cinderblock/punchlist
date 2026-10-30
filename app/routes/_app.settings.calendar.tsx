import { Alert, Button, Card, Checkbox, Code, CopyButton, Group, Radio, Stack, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { userActor } from "../../src/actors.ts";
import { type FeedScope, type PrivateMode, createFeed, listFeeds, revokeFeed } from "../../src/feeds.ts";
import { FEED_NAME_MAX_LENGTH } from "../../src/limits.ts";
import { listLabels } from "../../src/tasks.ts";
import { handleForm, stringField } from "../actions.server.ts";
import { requireUser } from "../auth.server.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import { whenText } from "../views.server.ts";
import type { Route } from "./+types/_app.settings.calendar";

export function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireUser(context, request);
  return {
    labels: listLabels(userActor(user)),
    feeds: listFeeds(user.id).map((f) => ({
      id: f.id,
      name: f.name,
      summary: `${f.scope === "public" ? "All public tasks" : f.scope === "public_and_mine" ? "Public, plus mine" : "Chosen labels"}${f.privateMode === "off" ? "" : f.privateMode === "titles" ? ", private as titles only" : ", with private tasks"}`,
      lastUsed: f.lastUsedAt ? whenText(f.lastUsedAt) : "never",
    })),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Calendar feeds");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireUser(context, request);
  return handleForm(request, {
    create: (form) => {
      const { url } = createFeed({
        ownerUserId: user.id,
        name: stringField(form, "name"),
        scope: stringField(form, "scope") as FeedScope,
        labelIds: form.getAll("labels").map(Number),
        privateMode: stringField(form, "privateMode") as PrivateMode,
      });
      return { ok: true, url };
    },
    revoke: (form) => {
      revokeFeed({ id: stringField(form, "id"), ownerUserId: user.id });
      return { ok: true, message: "Feed revoked." };
    },
  });
}

export default function Calendar({ loaderData }: Route.ComponentProps) {
  const { labels, feeds } = loaderData;
  const create = useFetcher<{ ok: boolean; url?: string; error?: string }>();
  const revoke = useFetcher();
  useActionFeedback(create.data);
  useActionFeedback(revoke.data);
  const [url, setUrl] = useState<string | null>(null);
  const [scope, setScope] = useState("public");
  const [privateMode, setPrivateMode] = useState("off");
  useEffect(() => {
    if (create.data?.url) setUrl(create.data.url);
  }, [create.data]);

  return (
    <Stack gap="lg" maw={640} mx="auto">
      <Stack gap={4}>
        <Title order={1} size="h2">
          Calendar feeds
        </Title>
        <Text size="sm" c="dimmed">
          Subscribe from Google Calendar, Apple Calendar or anything that takes an address. Tasks with a due date show up as all-day events. A calendar can't sign in, so the address itself is the key: anyone
          who has it can read the feed, until you revoke it.
        </Text>
      </Stack>

      {url && (
        <Alert color="blue" title="Your feed's address" withCloseButton onClose={() => setUrl(null)}>
          <Stack gap="xs">
            <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }} data-testid="feed-url">
              {url}
            </Code>
            <Group>
              <CopyButton value={url}>
                {({ copied, copy }) => (
                  <Button size="xs" variant={copied ? "filled" : "light"} onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Text size="sm">This is the only time it's shown.</Text>
          </Stack>
        </Alert>
      )}

      {feeds.length === 0 ? (
        <Text c="dimmed">No feeds yet.</Text>
      ) : (
        <Stack gap="sm">
          {feeds.map((f) => (
            <Card key={f.id} withBorder padding="sm" data-testid="feed">
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={0}>
                  <Text fw={500}>{f.name}</Text>
                  <Text size="sm" c="dimmed">
                    {f.summary}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Last fetched: {f.lastUsed}
                  </Text>
                </Stack>
                <Button size="xs" variant="subtle" color="red" onClick={() => revoke.submit({ intent: "revoke", id: f.id }, { method: "post" })}>
                  Revoke
                </Button>
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      <Card withBorder>
        <create.Form method="post">
          <input type="hidden" name="intent" value="create" />
          <Stack gap="md">
            <Title order={2} size="h4">
              New feed
            </Title>
            <TextInput name="name" label="Name" placeholder="Work calendar" required maxLength={FEED_NAME_MAX_LENGTH} />
            <Radio.Group name="scope" label="Covers" value={scope} onChange={setScope}>
              <Stack gap={6} mt={6}>
                <Radio value="public" label="All public tasks" />
                <Radio value="public_and_mine" label="Public tasks, plus mine" />
                <Radio value="labels" label="Only some labels" disabled={labels.length === 0} />
              </Stack>
            </Radio.Group>
            {scope === "labels" && (
              <Stack gap={4}>
                {labels.map((l) => (
                  <Checkbox key={l.id} name="labels" value={l.id} label={l.name} />
                ))}
              </Stack>
            )}
            {scope !== "public" && (
              <Radio.Group name="privateMode" label="My private tasks" description="Calendars are often shared and synced to other services, so these stay out unless you say." value={privateMode} onChange={setPrivateMode}>
              <Stack gap={6} mt={6}>
                <Radio value="off" label="Leave them out" />
                <Radio value="titles" label="Titles only" />
                <Radio value="full" label="Everything" />
              </Stack>
            </Radio.Group>
            )}
            <Group>
              <Button type="submit" loading={create.state !== "idle"}>
                Create feed
              </Button>
            </Group>
          </Stack>
        </create.Form>
      </Card>
    </Stack>
  );
}
