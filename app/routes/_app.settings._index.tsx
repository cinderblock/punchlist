import { Alert, Anchor, Button, Card, Group, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";

import { removeCredential, renameCredential } from "../../src/credentials.ts";
import { formatInstant } from "../../src/time.ts";
import { NAME_MAX_LENGTH } from "../../src/limits.ts";
import { mintRegistration } from "../../src/registrations.ts";
import { revokeAllSessions, revokeSession } from "../../src/sessions.ts";
import { renameUser } from "../../src/users.ts";
import { config } from "../../src/config.server.ts";
import { handleForm, intField, stringField } from "../actions.server.ts";
import { requireUser } from "../auth.server.ts";
import { PasskeyList, SessionList } from "../components/credential-lists.tsx";
import { LinkReveal, type RevealedLink } from "../components/link-reveal.tsx";
import { SignOutButton } from "../components/sign-out.tsx";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import { PasskeyError, passkeysSupported, registerPasskey } from "../passkey-client.ts";
import { passkeyViews, sessionViews } from "../views.server.ts";
import type { Route } from "./+types/_app.settings._index";

export function loader({ request, context }: Route.LoaderArgs) {
  const { user, session } = requireUser(context, request);
  return { name: user.name, role: user.role, passkeys: passkeyViews(user.id), sessions: sessionViews(user.id, session.id) };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Settings");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user, session } = requireUser(context, request);
  const self = { userId: user.id, actorUserId: user.id };
  return handleForm(request, {
    rename: (form) => {
      renameUser({ ...self, name: stringField(form, "name") });
      return { ok: true, message: "Name updated." };
    },
    "rename-passkey": (form) => {
      renameCredential({ ...self, id: intField(form, "credentialId"), nickname: stringField(form, "nickname") });
      return { ok: true, message: "Passkey renamed." };
    },
    "remove-passkey": (form) => {
      const removed = removeCredential({ ...self, id: intField(form, "credentialId") });
      return { ok: true, message: `Removed "${removed.nickname}".` };
    },
    "revoke-session": (form) => {
      revokeSession({ ...self, id: stringField(form, "sessionId") });
      return { ok: true, message: "Signed that device out." };
    },
    "revoke-sessions": () => {
      const n = revokeAllSessions({ ...self, exceptId: session.id });
      return { ok: true, message: `Signed out ${n} other device${n === 1 ? "" : "s"}.` };
    },
    "add-device": () => {
      const { url, registration } = mintRegistration({ purpose: "add_device", userId: user.id, createdBy: user.id });
      return { ok: true, link: { url, label: `Add a device for ${user.name}`, expires: formatInstant(registration.expiresAt, config.timezone) } };
    },
  });
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { name, role, passkeys, sessions } = loaderData;
  return (
    <Stack gap="xl" maw={640} mx="auto">
      <Stack gap={4}>
        <Title order={1} size="h2">
          Settings
        </Title>
        <Text c="dimmed">{role === "admin" ? "Admin" : "Member"}</Text>
        <Group gap="md">
          <Anchor component={Link} to="/settings/notifications">
            Notifications
          </Anchor>
          <Anchor component={Link} to="/settings/calendar">
            Calendar feeds
          </Anchor>
          <Anchor component={Link} to="/settings/agents">
            Agents
          </Anchor>
        </Group>
      </Stack>

      <RenameSelf name={name} />

      <Stack gap="sm">
        <Title order={2} size="h3">
          Passkeys
        </Title>
        <Text size="sm" c="dimmed">
          Each passkey lets one device (or one password manager) sign in. Keep at least two if you can, so losing a phone doesn't lock you out.
        </Text>
        <PasskeyList passkeys={passkeys} action="/settings" canRemoveLast={false} />
        <AddPasskeyButton />
        <AddDeviceLink />
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h3">
          Signed-in devices
        </Title>
        <SessionList sessions={sessions} action="/settings" revokeLabel="Sign out all other devices" />
      </Stack>

      <SignOutButton>
        {(signOut) => (
          <Group>
            <Button variant="default" onClick={signOut}>
              Sign out of this device
            </Button>
          </Group>
        )}
      </SignOutButton>
    </Stack>
  );
}

function RenameSelf({ name }: { name: string }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  return (
    <Card withBorder>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="rename" />
        <Group align="end" gap="xs">
          <TextInput name="name" label="Your name" defaultValue={name} maxLength={NAME_MAX_LENGTH} required style={{ flex: 1 }} autoComplete="name" />
          <Button type="submit" variant="light" loading={fetcher.state !== "idle"}>
            Save
          </Button>
        </Group>
      </fetcher.Form>
    </Card>
  );
}

function AddPasskeyButton() {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      if (!passkeysSupported()) throw new PasskeyError("This browser can't create passkeys.");
      await registerPasskey();
      notifications.show({ message: "Passkey added.", color: "green" });
      await revalidator.revalidate();
    } catch (err) {
      if (!(err instanceof PasskeyError && err.cancelled)) setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="xs">
      <Group>
        <Button variant="light" onClick={() => void add()} loading={busy}>
          Add a passkey on this device
        </Button>
      </Group>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
    </Stack>
  );
}

/** A one-time link for a device that can't sync a passkey. Signed-in people make their own. */
function AddDeviceLink() {
  const fetcher = useFetcher<{ ok: boolean; link?: RevealedLink; error?: string }>();
  useActionFeedback(fetcher.data);
  const [link, setLink] = useState<RevealedLink | null>(null);
  useEffect(() => {
    if (fetcher.data?.link) setLink(fetcher.data.link);
  }, [fetcher.data]);
  return (
    <Stack gap="xs">
      <Group>
        <Button variant="default" loading={fetcher.state !== "idle"} onClick={() => fetcher.submit({ intent: "add-device" }, { method: "post" })}>
          Link for another device
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        For a device with no synced passkey: open the link there, and it gets its own.
      </Text>
      <LinkReveal link={link} onClose={() => setLink(null)} />
    </Stack>
  );
}
