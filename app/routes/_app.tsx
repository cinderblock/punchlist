import { ActionIcon, Alert, Anchor, AppShell, Avatar, Badge, Burger, Button, Divider, Group, Image, NavLink, ScrollArea, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet, useFetcher, useLocation, useRevalidator, useRouteLoaderData } from "react-router";

import { actorLabel } from "../../src/actors.ts";
import { countOpenReports } from "../../src/feedback.ts";
import { activeNotices, noticeText } from "../../src/notices.ts";
import { getAuth, requireViewer } from "../auth.server.ts";
import { FeedbackIcon } from "../components/icons.tsx";
import { InstallHint } from "../components/install-hint.tsx";
import { SignOutButton } from "../components/sign-out.tsx";
import { usePendingChecks, useQueueFlusher } from "../offline/check-queue.ts";
import { isOfflineError, readCopy, writeCopy } from "../offline/copies.ts";
import type { loader as rootLoader } from "../root";
import { FeedbackDialog } from "../reporting/FeedbackDialog.tsx";
import { api } from "../tasks/api.ts";
import { useLiveUpdates } from "../tasks/live.ts";
import { whenText } from "../views.server.ts";
import type { Route } from "./+types/_app";

/**
 * Chrome for every page that shows tasks: navigation (a drawer on phones, a
 * sidebar on wider screens) and who you are. A signed-out visitor from the
 * internet never gets past this loader.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  const actor = requireViewer(context, request);
  if (actor.kind === "user") {
    const session = getAuth(context)?.session;
    return {
      me: { kind: "user" as const, id: actor.userId, name: actor.name, role: actor.role, label: actor.name },
      notices: activeNotices(actor.userId, session?.credentialId ?? null).map((n) => ({ id: n.id, text: noticeText(n, whenText(n.at)) })),
      openReports: actor.role === "admin" ? countOpenReports() : 0,
    };
  }
  return { me: { kind: "visitor" as const, label: actorLabel(actor), deviceName: actor.kind === "lan_device" ? actor.deviceName : null }, notices: [], openReports: 0 };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;
export type Me = LoaderData["me"];
export interface AppContext {
  me: Me;
}

const SHELL_COPY = "shell";

/** Offline, whoever was here last is shown. Nothing is sent until the server has checked again. */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  try {
    const fresh = await serverLoader();
    writeCopy(SHELL_COPY, fresh);
    return fresh;
  } catch (err) {
    const copy = isOfflineError(err) ? readCopy<LoaderData>(SHELL_COPY) : null;
    if (copy) return copy;
    throw err;
  }
}

const initials = (name: string) =>
  name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { me, notices, openReports } = loaderData;
  const root = useRouteLoaderData<typeof rootLoader>("root");
  const [opened, { toggle, close }] = useDisclosure();
  const [feedbackOpen, feedback] = useDisclosure();
  const location = useLocation();
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  const refresh = useCallback(() => void revalidate.current(), []);

  useLiveUpdates(refresh);
  useQueueFlusher(me.kind === "user" ? `user:${me.id}` : "visitor", refresh);
  const pending = usePendingChecks();

  // Close the phone drawer after navigating, and on the tap itself, because
  // tapping the page already shown changes no path.
  useEffect(close, [location.pathname, close]);

  const links = [
    { to: "/", label: "Tasks" },
    { to: "/map", label: "Map" },
    { to: "/activity", label: "Activity" },
    ...(me.kind === "user" ? [{ to: "/settings", label: "Settings" }] : []),
  ];
  const adminLinks =
    me.kind === "user" && me.role === "admin"
      ? [
          { to: "/admin/people", label: "People" },
          { to: "/admin/labels", label: "Labels" },
          { to: "/admin/audit", label: "Audit" },
          { to: "/admin/feedback", label: "Feedback", count: openReports },
        ]
      : [];
  const isActive = (to: string) => (to === "/" ? location.pathname === "/" || location.pathname.startsWith("/tasks/") : location.pathname === to || location.pathname.startsWith(`${to}/`));
  const renderLink = (link: { to: string; label: string; count?: number }) => (
    <NavLink
      key={link.to}
      component={Link}
      to={link.to}
      label={link.label}
      active={isActive(link.to)}
      onClick={close}
      rightSection={link.count ? <Badge size="sm" circle={link.count < 10} aria-label={`${link.count} to look at`}>{link.count}</Badge> : undefined}
    />
  );

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: "sm", collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Menu" />
            {root?.branding.hasLogo && <Image src="/logo.svg" alt="" h={28} w="auto" />}
            <Anchor component={Link} to="/" fw={700} size="lg" c="bright" underline="never" truncate>
              {root?.branding.name}
            </Anchor>
          </Group>
          <Group gap="sm" wrap="nowrap">
            {pending.length > 0 && (
              <Badge color="yellow" variant="light" data-testid="queue-badge">
                {pending.length} waiting to send
              </Badge>
            )}
            <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Send feedback" onClick={feedback.open}>
              <FeedbackIcon size={20} />
            </ActionIcon>
            {me.kind === "user" ? (
              <UnstyledButton component={Link} to="/settings" aria-label="Your settings">
                <Group gap="xs" wrap="nowrap">
                  <Text size="sm" visibleFrom="xs" truncate>
                    {me.name}
                  </Text>
                  <Avatar color="brand" radius="xl" size="md">
                    {initials(me.name)}
                  </Avatar>
                </Group>
              </UnstyledButton>
            ) : (
              <Button component={Link} to="/signin" variant="light" size="compact-md">
                Sign in
              </Button>
            )}
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppShell.Section grow component={ScrollArea}>
          <Stack gap={4}>
            {links.map(renderLink)}
            {adminLinks.length > 0 && (
              <>
                <Divider my="xs" label="Admin" labelPosition="left" />
                {adminLinks.map(renderLink)}
              </>
            )}
          </Stack>
        </AppShell.Section>
        <AppShell.Section>
          {me.kind === "user" ? (
            <SignOutButton>{(signOut) => <NavLink component="button" type="button" label="Sign out" c="dimmed" onClick={signOut} />}</SignOutButton>
          ) : (
            <VisitorPanel me={me} onSaved={refresh} />
          )}
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        {notices.length > 0 && <AccountNotices notices={notices} />}
        {me.kind === "user" && <InstallHint />}
        <Outlet context={{ me } satisfies AppContext} />
      </AppShell.Main>
      <FeedbackDialog opened={feedbackOpen} onClose={feedback.close} signedIn={me.kind === "user"} />
    </AppShell>
  );
}

/** Something was done to this account. It stays until it's been read. */
function AccountNotices({ notices }: { notices: { id: number; text: string }[] }) {
  const fetcher = useFetcher();
  return (
    <Alert color="red" mb="md" title="Your account was accessed" role="alert" data-testid="account-notice">
      <Stack gap="xs">
        {notices.map((n) => (
          <Text key={n.id} size="sm">
            {n.text}
          </Text>
        ))}
        <Group gap="xs">
          <Button size="compact-sm" variant="light" color="red" loading={fetcher.state !== "idle"} onClick={() => fetcher.submit({ intent: "ack-notices" }, { method: "post", action: "/settings" })}>
            I've read this
          </Button>
          <Button size="compact-sm" variant="subtle" component={Link} to="/settings">
            See my passkeys
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}

/** An on-site visitor can say who they are. It's labelled unverified everywhere it shows. */
function VisitorPanel({ me, onSaved }: { me: Extract<Me, { kind: "visitor" }>; onSaved: () => void }) {
  const [name, setName] = useState(me.deviceName ?? "");
  const [saved, setSaved] = useState(false);
  return (
    <Stack gap={4} p={4}>
      <Text size="sm" fw={500}>
        {me.label}
      </Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void api("/api/v1/device", { method: "PATCH", body: { name } }).then(() => {
            setSaved(true);
            onSaved();
          });
        }}
      >
        <TextInput size="xs" label="Your name (optional)" value={name} maxLength={40} onChange={(e) => setName(e.currentTarget.value)} />
        <Button type="submit" size="compact-sm" variant="subtle" mt={4}>
          Save
        </Button>
      </form>
      {saved && (
        <Alert color="gray" p={6}>
          <Text size="xs">Shown as unverified. Sign in to keep private tasks.</Text>
        </Alert>
      )}
    </Stack>
  );
}
