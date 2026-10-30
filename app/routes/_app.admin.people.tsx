import { Alert, Anchor, Badge, Button, Card, Group, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import { config } from "../../src/config.server.ts";
import { NAME_MAX_LENGTH } from "../../src/limits.ts";
import { listOpenRegistrations, mintRegistration, revokeRegistration } from "../../src/registrations.ts";
import { formatInstant } from "../../src/time.ts";
import { type Role, listUsers } from "../../src/users.ts";
import { handleForm, intField, stringField } from "../actions.server.ts";
import { requireAdmin } from "../auth.server.ts";
import { LinkReveal, type RevealedLink } from "../components/link-reveal.tsx";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import { whenText } from "../views.server.ts";
import type { Route } from "./+types/_app.admin.people";

export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  return {
    people: listUsers().map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      active: u.active,
      passkeys: u.passkeyCount,
      lastSeen: u.lastSeenAt ? whenText(u.lastSeenAt) : "never",
    })),
    links: listOpenRegistrations().map((r) => ({
      id: r.id,
      label: r.purpose === "invite" ? `Invite${r.nameHint ? ` for ${r.nameHint}` : ""} (${r.role})` : r.purpose === "add_device" ? `Device link for ${r.targetName}` : "First-admin setup",
      expires: whenText(r.expiresAt),
    })),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "People");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireAdmin(context, request);
  return handleForm(request, {
    invite: (form) => {
      const role = stringField(form, "role") === "admin" ? ("admin" as Role) : ("member" as Role);
      const nameHint = stringField(form, "name");
      const { url, registration } = mintRegistration({ purpose: "invite", role, nameHint, createdBy: user.id });
      return { ok: true, link: { url, label: `Invite${nameHint ? ` for ${nameHint}` : ""} (${role})`, expires: formatInstant(registration.expiresAt, config.timezone) } };
    },
    revoke: (form) => {
      revokeRegistration({ id: intField(form, "id"), actorUserId: user.id });
      return { ok: true, message: "Link revoked." };
    },
  });
}

export default function People({ loaderData }: Route.ComponentProps) {
  const { people, links } = loaderData;
  const invite = useFetcher<{ ok: boolean; link?: RevealedLink; error?: string }>();
  const revoke = useFetcher();
  useActionFeedback(invite.data);
  useActionFeedback(revoke.data);
  const [link, setLink] = useState<RevealedLink | null>(null);
  useEffect(() => {
    if (invite.data?.link) setLink(invite.data.link);
  }, [invite.data]);

  return (
    <Stack gap="lg" maw={720} mx="auto">
      <Title order={1} size="h2">
        People
      </Title>

      <Alert color="gray">
        Admins can invite and deactivate people, and manage labels. Being an admin doesn't show anyone's private tasks here. Anyone with access to the server could still read its database, and this page won't
        pretend otherwise.
      </Alert>

      <Stack gap="xs">
        {people.map((p) => (
          <Card key={p.id} withBorder padding="sm">
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={0}>
                <Anchor component={Link} to={`/admin/people/${p.id}`} fw={500}>
                  {p.name}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {p.passkeys} passkey{p.passkeys === 1 ? "" : "s"}, last seen {p.lastSeen}
                </Text>
              </Stack>
              <Group gap={4}>
                {p.role === "admin" && <Badge variant="light">admin</Badge>}
                {!p.active && (
                  <Badge color="gray" variant="light">
                    deactivated
                  </Badge>
                )}
              </Group>
            </Group>
          </Card>
        ))}
      </Stack>

      <Card withBorder>
        <invite.Form method="post">
          <input type="hidden" name="intent" value="invite" />
          <Stack gap="sm">
            <Title order={2} size="h4">
              Invite someone
            </Title>
            <Text size="sm" c="dimmed">
              Makes a one-time link, good for 24 hours, from anywhere.
            </Text>
            <Group align="end">
              <TextInput name="name" label="Their name" maxLength={NAME_MAX_LENGTH} style={{ flex: 1 }} />
              <Select name="role" label="Role" allowDeselect={false} defaultValue="member" data={["member", "admin"]} w={130} />
            </Group>
            <Group>
              <Button type="submit" loading={invite.state !== "idle"}>
                Create invite link
              </Button>
            </Group>
          </Stack>
        </invite.Form>
      </Card>

      {links.length > 0 && (
        <Stack gap="xs">
          <Title order={2} size="h4">
            Open links
          </Title>
          {links.map((l) => (
            <Group key={l.id} justify="space-between" wrap="nowrap">
              <Stack gap={0}>
                <Text size="sm">{l.label}</Text>
                <Text size="xs" c="dimmed">
                  Until {l.expires}
                </Text>
              </Stack>
              <Button size="xs" variant="subtle" color="red" onClick={() => revoke.submit({ intent: "revoke", id: String(l.id) }, { method: "post" })}>
                Revoke
              </Button>
            </Group>
          ))}
        </Stack>
      )}

      <LinkReveal link={link} onClose={() => setLink(null)} />
    </Stack>
  );
}
