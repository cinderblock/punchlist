import { Alert, Badge, Button, Card, Chip, Group, MultiSelect, NumberInput, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { config } from "../../src/config.server.ts";
import type { NotificationPrefs } from "../../src/notifications/prefs-schema.ts";
import { pushConfigured } from "../../src/notifications/send.ts";
import { addSubscription, getPrefs, listSubscriptions, liveSubscriptions, parseBrowserSubscription, recentNotifications, removeSubscription, setPrefs } from "../../src/notifications/store.ts";
import { appSender, sendTest } from "../../src/notifications/worker.ts";
import { listLabels, listZones } from "../../src/tasks.ts";
import { userActor } from "../../src/actors.ts";
import { handleForm, stringField } from "../actions.server.ts";
import { requireUser } from "../auth.server.ts";
import { InstallSteps } from "../components/install-hint.tsx";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import { PushError, type PushSupport, currentSubscription, pushSupport, subscribe, unsubscribe } from "../pwa/push-client.ts";
import { whenText } from "../views.server.ts";
import type { Route } from "./+types/_app.settings.notifications";

export function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireUser(context, request);
  const actor = userActor(user);
  const live = new Set(liveSubscriptions(user.id).map((s) => s.id));
  return {
    available: pushConfigured(),
    vapidPublicKey: config.push.vapidPublicKey,
    timeZone: config.timezone,
    prefs: getPrefs(user.id),
    labels: listLabels(actor),
    zones: listZones(actor),
    devices: listSubscriptions(user.id).map((s) => ({
      id: s.id,
      endpoint: s.endpoint,
      label: s.label,
      live: live.has(s.id),
      added: whenText(s.createdAt),
      lastError: s.lastError,
    })),
    recent: recentNotifications(user.id).map((n) => ({ ...n, when: whenText(n.at) })),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Notifications");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user, session } = requireUser(context, request);
  const userAgent = request.headers.get("User-Agent");
  return handleForm(request, {
    "push-subscribe": (form) => {
      const subscription = parseBrowserSubscription(JSON.parse(stringField(form, "subscription")));
      addSubscription({ userId: user.id, sessionId: session.id, subscription, userAgent });
      return { ok: true, message: "Notifications are on for this device." };
    },
    "push-forget": (form) => {
      removeSubscription({ userId: user.id, endpoint: stringField(form, "endpoint") });
      return { ok: true, message: "Notifications are off for this device." };
    },
    "push-remove": (form) => {
      removeSubscription({ userId: user.id, id: Number(stringField(form, "deviceId")) });
      return { ok: true, message: "Removed." };
    },
    "push-test": async (form) => {
      const result = await sendTest({ userId: user.id, sender: appSender(), endpoint: stringField(form, "endpoint") || undefined });
      return result.delivered > 0 ? { ok: true, message: "Sent. It should arrive in a moment." } : { ok: false, error: result.errors[0] ?? "No device took it." };
    },
    prefs: (form) => {
      setPrefs(user.id, JSON.parse(stringField(form, "prefs")));
      return { ok: true, message: "Saved." };
    },
  });
}

function supportMessage(support: PushSupport): string | null {
  switch (support.kind) {
    case "ready":
    case "ios-needs-install":
      return null;
    case "unsupported":
      return "This browser can't receive notifications.";
    case "denied":
      return "Notifications are blocked for this site in this browser. Allow them in the site's settings, then reload this page.";
    case "no-worker":
      return "The app's background helper isn't running in this window. Reload the page and try again.";
  }
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const { available, vapidPublicKey, prefs, labels, zones, devices, recent, timeZone } = loaderData;
  return (
    <Stack gap="lg" maw={640} mx="auto">
      <Stack gap={4}>
        <Title order={1} size="h2">
          Notifications
        </Title>
        <Text size="sm" c="dimmed">
          Pick what you want to hear about, then turn them on for each device. Only signed-in people can get them.
        </Text>
      </Stack>
      {!available && <Alert color="yellow">This server isn't set up to send notifications: it has no VAPID key. Your choices below are kept for when it does.</Alert>}
      {available && vapidPublicKey && <ThisDevice vapidPublicKey={vapidPublicKey} devices={devices} />}
      {devices.length > 0 && <Devices devices={devices} />}
      <PrefsForm prefs={prefs} labels={labels} zones={zones} timeZone={timeZone} />
      {recent.length > 0 && (
        <Stack gap={4}>
          <Title order={2} size="h4">
            Recently sent
          </Title>
          {recent.map((n) => (
            <div key={n.id}>
              <Text size="sm">{n.title}</Text>
              <Text size="xs" c="dimmed">
                {n.waiting ? "Waiting for quiet hours to end" : n.when}
              </Text>
            </div>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

type Device = Route.ComponentProps["loaderData"]["devices"][number];

function ThisDevice({ vapidPublicKey, devices }: { vapidPublicKey: string; devices: Device[] }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void pushSupport().then(setSupport);
    void currentSubscription().then((s) => setEndpoint(s?.endpoint ?? null));
  }, []);

  const mine = endpoint ? devices.find((d) => d.endpoint === endpoint) : undefined;

  async function turnOn() {
    setBusy(true);
    setProblem(null);
    try {
      const json = await subscribe(vapidPublicKey);
      setEndpoint(json.endpoint ?? null);
      fetcher.submit({ intent: "push-subscribe", subscription: JSON.stringify(json) }, { method: "post" });
    } catch (err) {
      setProblem(err instanceof PushError ? err.message : "The browser wouldn't set up notifications. Try again.");
      void pushSupport().then(setSupport);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      const gone = (await unsubscribe()) ?? mine?.endpoint ?? "";
      setEndpoint(null);
      fetcher.submit({ intent: "push-forget", endpoint: gone }, { method: "post" });
    } finally {
      setBusy(false);
    }
  }

  if (!support || endpoint === undefined) return null;
  const message = supportMessage(support);
  const on = Boolean(mine);

  return (
    <Card withBorder data-testid="this-device">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={500}>This device</Text>
          <Badge color={on ? "green" : "gray"} variant="light">
            {on ? "On" : "Off"}
          </Badge>
        </Group>
        {support.kind === "ios-needs-install" ? (
          <Stack gap={4}>
            <Text size="sm">An iPhone or iPad can only get notifications in the app on its Home Screen (iOS 16.4 or later):</Text>
            <InstallSteps />
          </Stack>
        ) : message ? (
          <Text size="sm" c="dimmed">
            {message}
          </Text>
        ) : (
          <Group gap="xs">
            {on ? (
              <>
                <Button variant="light" loading={fetcher.state !== "idle"} onClick={() => fetcher.submit({ intent: "push-test", endpoint: endpoint ?? "" }, { method: "post" })}>
                  Send a test
                </Button>
                <Button variant="default" onClick={() => void turnOff()} loading={busy}>
                  Turn off here
                </Button>
              </>
            ) : (
              <Button onClick={() => void turnOn()} loading={busy || fetcher.state !== "idle"}>
                Turn on notifications here
              </Button>
            )}
          </Group>
        )}
        {problem && (
          <Alert color="yellow" role="alert">
            {problem}
          </Alert>
        )}
      </Stack>
    </Card>
  );
}

function Devices({ devices }: { devices: Device[] }) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Text fw={500}>Devices that get them</Text>
        {devices.map((d) => (
          <Group key={d.id} justify="space-between" wrap="nowrap" align="start" data-testid="push-device">
            <Stack gap={0}>
              <Text size="sm">
                {d.label}
                {!d.live ? ", signed out" : ""}
              </Text>
              <Text size="xs" c="dimmed">
                Added {d.added}
              </Text>
              {d.lastError && (
                <Text size="xs" c="red">
                  Last try failed: {d.lastError}
                </Text>
              )}
            </Stack>
            <Button size="xs" variant="subtle" color="red" onClick={() => fetcher.submit({ intent: "push-remove", deviceId: String(d.id) }, { method: "post" })}>
              Remove
            </Button>
          </Group>
        ))}
      </Stack>
    </Card>
  );
}

function PrefsForm({
  prefs,
  labels,
  zones,
  timeZone,
}: {
  prefs: NotificationPrefs;
  labels: { id: number; name: string }[];
  zones: { id: string; name: string }[];
  timeZone: string;
}) {
  const fetcher = useFetcher();
  useActionFeedback(fetcher.data);
  const [p, setP] = useState(prefs);
  useEffect(() => setP(prefs), [prefs]);
  const dirty = JSON.stringify(p) !== JSON.stringify(prefs);

  const set = <K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K] extends object ? Partial<NotificationPrefs[K]> : NotificationPrefs[K]) =>
    setP((prev) => ({ ...prev, [key]: typeof value === "object" && value !== null ? { ...(prev[key] as object), ...value } : value }));

  return (
    <Card withBorder>
      <Stack gap="md">
        <Switch label="Assigned to me" checked={p.assigned} onChange={(e) => set("assigned", e.currentTarget.checked)} />
        <Switch label="Comments on my tasks" checked={p.comments} onChange={(e) => set("comments", e.currentTarget.checked)} />

        <Stack gap={6}>
          <Switch label="My tasks coming due" checked={p.dueSoon.on} onChange={(e) => set("dueSoon", { on: e.currentTarget.checked })} />
          <Group gap="sm" ml="xl">
            <NumberInput label="Days ahead" min={0} max={14} w={110} value={p.dueSoon.days} disabled={!p.dueSoon.on} onChange={(v) => set("dueSoon", { days: typeof v === "number" ? v : 1 })} />
            <TextInput label="At" type="time" w={130} value={p.dueSoon.at} disabled={!p.dueSoon.on} onChange={(e) => set("dueSoon", { at: e.currentTarget.value })} />
          </Group>
        </Stack>

        <Stack gap={6}>
          <Switch label="A daily list of my overdue tasks" checked={p.overdueDigest.on} onChange={(e) => set("overdueDigest", { on: e.currentTarget.checked })} />
          <TextInput label="At" type="time" w={130} ml="xl" value={p.overdueDigest.at} disabled={!p.overdueDigest.on} onChange={(e) => set("overdueDigest", { at: e.currentTarget.value })} />
        </Stack>

        <Stack gap={6}>
          <Text fw={500} size="sm">
            New tasks in
          </Text>
          {labels.length > 0 && (
            <Chip.Group multiple value={p.watch.labels.map(String)} onChange={(v) => set("watch", { labels: v.map(Number) })}>
              <Group gap={6}>
                {labels.map((l) => (
                  <Chip key={l.id} value={String(l.id)} size="sm">
                    {l.name}
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          )}
          {zones.length > 0 && (
            <MultiSelect aria-label="Zones to watch" placeholder="Zones" data={zones.map((z) => ({ value: z.id, label: z.name }))} value={p.watch.zones} onChange={(v) => set("watch", { zones: v })} />
          )}
          {labels.length === 0 && zones.length === 0 && (
            <Text size="sm" c="dimmed">
              This space has no labels or zones to watch yet.
            </Text>
          )}
        </Stack>

        <Stack gap={6}>
          <Switch
            label="Quiet hours"
            description={`Nothing buzzes in this window; it waits until it ends. Times are ${timeZone}.`}
            checked={p.quietHours.on}
            onChange={(e) => set("quietHours", { on: e.currentTarget.checked })}
          />
          <Group gap="sm" ml="xl">
            <TextInput label="From" type="time" w={130} value={p.quietHours.from} disabled={!p.quietHours.on} onChange={(e) => set("quietHours", { from: e.currentTarget.value })} />
            <TextInput label="Until" type="time" w={130} value={p.quietHours.until} disabled={!p.quietHours.on} onChange={(e) => set("quietHours", { until: e.currentTarget.value })} />
          </Group>
        </Stack>

        <TextInput
          label="Pause everything through"
          description="Nothing is sent up to and including this day, and it isn't saved for later."
          type="date"
          maw={220}
          value={p.pausedThrough ?? ""}
          onChange={(e) => setP((prev) => ({ ...prev, pausedThrough: e.currentTarget.value || null }))}
        />

        <Group>
          <Button disabled={!dirty} loading={fetcher.state !== "idle"} onClick={() => fetcher.submit({ intent: "prefs", prefs: JSON.stringify(p) }, { method: "post" })}>
            Save
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
