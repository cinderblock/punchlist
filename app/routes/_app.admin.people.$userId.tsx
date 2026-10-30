import { Anchor, Badge, Button, Card, Group, SegmentedControl, Stack, Switch, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { Link, data, useFetcher } from "react-router";

import { userActor } from "../../src/actors.ts";
import { listAgents, revokeAgent } from "../../src/agents.ts";
import { config } from "../../src/config.server.ts";
import { removeCredential, renameCredential } from "../../src/credentials.ts";
import { mintRegistration } from "../../src/registrations.ts";
import { revokeAllSessions, revokeSession } from "../../src/sessions.ts";
import { formatInstant } from "../../src/time.ts";
import { type Role, getUser, updateUserAccess } from "../../src/users.ts";
import { handleForm, intField, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { PasskeyList, SessionList } from "../components/credential-lists.tsx";
import { LinkReveal, type RevealedLink } from "../components/link-reveal.tsx";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import { passkeyViews, sessionViews, whenText } from "../views.server.ts";
import type { Route } from "./+types/_app.admin.people.$userId";

function target(params: { userId: string }) {
  const user = getUser(Number(params.userId));
  if (!user) throw data("That person doesn't exist.", { status: 404 });
  return user;
}

export function loader({ request, context, params }: Route.LoaderArgs) {
  requireAdmin(context, request);
  const user = target(params);
  return {
    person: { id: user.id, name: user.name, role: user.role, active: user.active },
    passkeys: passkeyViews(user.id),
    sessions: sessionViews(user.id, null),
    agents: listAgents(user.id)
      .filter((a) => a.revokedAt == null)
      .map((a) => ({ id: a.id, name: a.name, scopes: a.scopes, lastUsed: a.lastUsedAt ? whenText(a.lastUsedAt) : "never" })),
  };
}

export function meta({ matches, loaderData }: Route.MetaArgs) {
  return pageTitle(matches, loaderData?.person.name ?? "Person");
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const { user: admin } = requireAdmin(context, request);
  const user = target(params);
  const on = { userId: user.id, actorUserId: admin.id };
  return handleForm(request, {
    role: (form) => {
      updateUserAccess({ ...on, role: stringField(form, "role") as Role });
      return { ok: true, message: "Role changed." };
    },
    active: (form) => {
      const active = stringField(form, "active") === "1";
      updateUserAccess({ ...on, active });
      return { ok: true, message: active ? "Reactivated." : "Deactivated: signed out everywhere, and their agents and feeds have stopped." };
    },
    recovery: () => {
      const { url, registration } = mintRegistration({ purpose: "add_device", userId: user.id, createdBy: admin.id });
      return { ok: true, message: admin.id === user.id ? undefined : `${user.name} has been signed out everywhere, and will be told.`, link: { url, label: `Recovery link for ${user.name}`, expires: formatInstant(registration.expiresAt, config.timezone) } };
    },
    "rename-passkey": (form) => {
      renameCredential({ ...on, id: intField(form, "credentialId"), nickname: stringField(form, "nickname") });
      return { ok: true, message: "Passkey renamed." };
    },
    "remove-passkey": (form) => {
      const removed = removeCredential({ ...on, id: intField(form, "credentialId") });
      return { ok: true, message: `Removed "${removed.nickname}".` };
    },
    "revoke-session": (form) => {
      revokeSession({ ...on, id: stringField(form, "sessionId") });
      return { ok: true, message: "Signed that device out." };
    },
    "revoke-sessions": () => {
      const n = revokeAllSessions(on);
      return { ok: true, message: `Signed out ${n} device${n === 1 ? "" : "s"}.` };
    },
    "revoke-agent": (form) => {
      revokeAgent({ id: stringField(form, "id"), actor: userActor(admin) });
      return { ok: true, message: "Agent revoked." };
    },
  });
}

export default function Person({ loaderData }: Route.ComponentProps) {
  const { person, passkeys, sessions, agents } = loaderData;
  const fetcher = useFetcher<{ ok: boolean; link?: RevealedLink; error?: string; message?: string }>();
  useActionFeedback(fetcher.data);
  const [link, setLink] = useState<RevealedLink | null>(null);
  useEffect(() => {
    if (fetcher.data?.link) setLink(fetcher.data.link);
  }, [fetcher.data]);
  const action = `/admin/people/${person.id}`;

  return (
    <Stack gap="lg" maw={640} mx="auto">
      <Anchor component={Link} to="/admin/people" size="sm">
        People
      </Anchor>
      <Group gap="sm">
        <Title order={1} size="h2">
          {person.name}
        </Title>
        {!person.active && (
          <Badge color="gray" variant="light">
            deactivated
          </Badge>
        )}
      </Group>

      <Card withBorder>
        <Stack gap="sm">
          <Switch
            label="Can sign in"
            description="Off: signed out everywhere, and their agents and calendar feeds stop too."
            checked={person.active}
            disabled={fetcher.state !== "idle"}
            onChange={(e) => fetcher.submit({ intent: "active", active: e.currentTarget.checked ? "1" : "0" }, { method: "post" })}
          />
          <SegmentedControl
            aria-label="Role"
            value={person.role}
            onChange={(role) => fetcher.submit({ intent: "role", role }, { method: "post" })}
            data={[
              { value: "member", label: "Member" },
              { value: "admin", label: "Admin" },
            ]}
          />
        </Stack>
      </Card>

      <Stack gap="sm">
        <Title order={2} size="h4">
          Passkeys
        </Title>
        <PasskeyList passkeys={passkeys} action={action} canRemoveLast />
        <Group>
          <Button variant="light" disabled={!person.active} loading={fetcher.state !== "idle"} onClick={() => fetcher.submit({ intent: "recovery" }, { method: "post" })}>
            Make a recovery link
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          For someone who's lost every device. Opening it adds a new passkey to this account. Making one signs {person.name} out everywhere, and they'll be told who made it and when, permanently.
        </Text>
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h4">
          Signed-in devices
        </Title>
        <SessionList sessions={sessions} action={action} revokeLabel="Sign out everywhere" />
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h4">
          Agents
        </Title>
        {agents.length === 0 && (
          <Text size="sm" c="dimmed">
            None.
          </Text>
        )}
        {agents.map((a) => (
          <Card key={a.id} withBorder padding="sm">
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={0}>
                <Text fw={500}>{a.name}</Text>
                <Text size="xs" c="dimmed">
                  {a.scopes.join(", ")}, last used {a.lastUsed}
                </Text>
              </Stack>
              <Button size="xs" variant="subtle" color="red" onClick={() => fetcher.submit({ intent: "revoke-agent", id: a.id }, { method: "post" })}>
                Revoke
              </Button>
            </Group>
          </Card>
        ))}
      </Stack>

      <LinkReveal link={link} onClose={() => setLink(null)} />
    </Stack>
  );
}
