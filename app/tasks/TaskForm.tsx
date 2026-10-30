import { Button, Group, Modal, MultiSelect, NumberInput, Select, Stack, Switch, Text, TextInput, Textarea } from "@mantine/core";
import { useState } from "react";

import type { SiteMap as SiteMapConfig } from "../../src/config-schema.ts";
import { pointInPolygon } from "../../src/geometry.ts";
import { DETAILS_MAX_LENGTH, LOCATION_NOTE_MAX_LENGTH, TITLE_MAX_LENGTH } from "../../src/limits.ts";
import type { LabelView, TaskView, ZoneView } from "../../src/tasks.ts";
import { SiteMap } from "../components/site-map.tsx";

export interface FormOptions {
  labels: readonly LabelView[];
  zones: readonly ZoneView[];
  people: readonly { id: number; name: string }[];
  maps: readonly SiteMapConfig[];
  today: string;
}

/** What may be changed here. Absent means a new task, by someone signed in or not. */
export interface FormRights {
  assign: boolean;
  share: boolean;
  visibility: boolean;
  recurrence: boolean;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

type RepeatChoice = "none" | "daily" | "weekly" | "biweekly" | "monthly" | "nth" | "yearly" | "after" | "custom";

/** The "first Monday" of the month a date falls in. */
function nthWeekday(date: string): { rule: string; text: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const n = Math.floor((d.getUTCDate() - 1) / 7);
  const day = d.getUTCDay();
  return { rule: `FREQ=MONTHLY;BYDAY=${n + 1}${WEEKDAYS[day]}`, text: `The ${ORDINALS[n]} ${WEEKDAY_NAMES[day]} of each month` };
}

function ruleFor(choice: RepeatChoice, date: string, custom: string): string {
  switch (choice) {
    case "daily":
      return "FREQ=DAILY";
    case "weekly":
      return "FREQ=WEEKLY";
    case "biweekly":
      return "FREQ=WEEKLY;INTERVAL=2";
    case "monthly":
      return "FREQ=MONTHLY";
    case "yearly":
      return "FREQ=YEARLY";
    case "nth":
      return nthWeekday(date).rule;
    default:
      return custom;
  }
}

function initialRepeat(task: TaskView | null): RepeatChoice {
  if (!task?.recurrence) return "none";
  if (task.recurrence.kind === "after_completion") return "after";
  return "custom";
}

export interface TaskPayload {
  title: string;
  details: string;
  dueDate: string | null;
  labels: number[];
  visibility?: "public" | "private";
  assignees?: number[];
  sharedWith?: number[];
  location: { mapId?: string | null; x?: number | null; y?: number | null; zoneId?: string | null; note?: string | null } | null;
  recurrence?: { kind: "schedule"; rrule: string } | { kind: "after_completion"; intervalDays: number } | null;
}

/** Create and edit share this. The server re-checks everything it offers. */
export function TaskForm({
  task,
  initialTitle,
  options,
  rights,
  saveLabel,
  busy,
  onSave,
  onCancel,
}: {
  task: TaskView | null;
  initialTitle?: string;
  options: FormOptions;
  rights: FormRights;
  saveLabel: string;
  busy: boolean;
  onSave: (payload: TaskPayload) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? initialTitle ?? "");
  const [details, setDetails] = useState(task?.details ?? "");
  const [dueDate, setDueDate] = useState(task?.dueDate ?? "");
  const [labels, setLabels] = useState((task?.labels ?? []).map((l) => String(l.id)));
  const [isPrivate, setPrivate] = useState(task?.visibility === "private");
  const [assignees, setAssignees] = useState((task?.assignees ?? []).map((a) => String(a.id)));
  const [shared, setShared] = useState((task?.sharedWith ?? []).map((a) => String(a.id)));
  const [zoneId, setZoneId] = useState(task?.location?.zoneId ?? "");
  const [point, setPoint] = useState<{ mapId: string; x: number; y: number } | null>(
    task?.location?.mapId && task.location.x != null && task.location.y != null ? { mapId: task.location.mapId, x: task.location.x, y: task.location.y } : null,
  );
  const [note, setNote] = useState(task?.location?.note ?? "");
  const [picking, setPicking] = useState(false);
  const [mapId, setMapId] = useState(point?.mapId ?? options.maps[0]?.id ?? "");
  const [repeat, setRepeat] = useState<RepeatChoice>(initialRepeat(task));
  const [customRule, setCustomRule] = useState(task?.recurrence?.rrule ?? "");
  const [intervalDays, setIntervalDays] = useState<number>(task?.recurrence?.intervalDays ?? 30);

  const repeatDate = dueDate || options.today;
  const map = options.maps.find((m) => m.id === mapId) ?? null;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    let recurrence: TaskPayload["recurrence"];
    if (rights.recurrence) {
      if (repeat === "none") recurrence = task?.recurrence ? null : undefined;
      else if (repeat === "after") recurrence = { kind: "after_completion", intervalDays };
      else {
        const rrule = ruleFor(repeat, repeatDate, customRule);
        // Unchanged, it stays the same rule rather than a new one that restarts it.
        recurrence = task?.recurrence?.rrule === rrule ? undefined : { kind: "schedule", rrule };
      }
      if (task?.recurrence?.kind === "after_completion" && repeat === "after" && task.recurrence.intervalDays === intervalDays) recurrence = undefined;
    }
    onSave({
      title,
      details,
      dueDate: dueDate || null,
      labels: labels.map(Number),
      ...(rights.visibility ? { visibility: isPrivate ? ("private" as const) : ("public" as const) } : {}),
      ...(rights.assign ? { assignees: assignees.map(Number) } : {}),
      ...(rights.share && isPrivate ? { sharedWith: shared.map(Number) } : {}),
      location: point ? { mapId: point.mapId, x: point.x, y: point.y, note: note || null } : zoneId || note ? { zoneId: zoneId || null, note: note || null } : null,
      ...(recurrence !== undefined ? { recurrence } : {}),
    });
  }

  const people = options.people.map((p) => ({ value: String(p.id), label: p.name }));
  const derivedZone = point ? map?.zones.find((z) => pointInPolygon(point.x, point.y, z.polygon))?.name : null;

  return (
    <form onSubmit={submit}>
      <Stack gap="md">
        <TextInput label="What needs doing?" required maxLength={TITLE_MAX_LENGTH} value={title} onChange={(e) => setTitle(e.currentTarget.value)} data-autofocus />
        <Textarea label="Details" autosize minRows={2} maxLength={DETAILS_MAX_LENGTH} value={details} onChange={(e) => setDetails(e.currentTarget.value)} />
        <TextInput label="Due" type="date" value={dueDate} onChange={(e) => setDueDate(e.currentTarget.value)} maw={220} />

        {options.labels.length > 0 && (
          <MultiSelect label="Labels" data={options.labels.map((l) => ({ value: String(l.id), label: l.name }))} value={labels} onChange={setLabels} searchable clearable />
        )}

        {(options.zones.length > 0 || options.maps.length > 0) && (
          <Stack gap={6}>
            <Group align="end" gap="xs">
              {options.zones.length > 0 && (
                <Select
                  label="Where"
                  placeholder="Pick a zone"
                  style={{ flex: 1 }}
                  clearable
                  disabled={point != null}
                  data={options.zones.map((z) => ({ value: z.id, label: z.name }))}
                  value={zoneId || null}
                  onChange={(v) => setZoneId(v ?? "")}
                />
              )}
              {options.maps.length > 0 && (
                <Button variant="light" onClick={() => setPicking(true)}>
                  {point ? "Move on map" : "Pick on map"}
                </Button>
              )}
            </Group>
            {point && (
              <Group gap="xs">
                <Text size="sm" c="dimmed" data-testid="picked-point">
                  {derivedZone ?? "On the map"} ({point.x.toFixed(1)}, {point.y.toFixed(1)} {map?.units})
                </Text>
                <Button variant="subtle" size="compact-xs" onClick={() => setPoint(null)}>
                  Clear
                </Button>
              </Group>
            )}
          </Stack>
        )}
        <TextInput label="Location note" placeholder="Top shelf, behind the door" maxLength={LOCATION_NOTE_MAX_LENGTH} value={note} onChange={(e) => setNote(e.currentTarget.value)} />

        {rights.recurrence && (
          <Stack gap={6}>
            <Select
              label="Repeats"
              allowDeselect={false}
              value={repeat}
              onChange={(v) => setRepeat((v as RepeatChoice) ?? "none")}
              data={[
                { value: "none", label: "Doesn't repeat" },
                { value: "daily", label: "Every day" },
                { value: "weekly", label: "Every week" },
                { value: "biweekly", label: "Every 2 weeks" },
                { value: "monthly", label: "Every month, same date" },
                { value: "nth", label: nthWeekday(repeatDate).text },
                { value: "yearly", label: "Every year" },
                { value: "after", label: "Some days after it's done" },
                { value: "custom", label: "Custom rule" },
              ]}
            />
            {repeat === "after" && (
              <NumberInput label="Days after it's done" min={1} max={3660} value={intervalDays} onChange={(v) => setIntervalDays(typeof v === "number" ? v : 30)} maw={220} />
            )}
            {repeat === "custom" && <TextInput label="RRULE" placeholder="FREQ=MONTHLY;BYDAY=1MO" value={customRule} onChange={(e) => setCustomRule(e.currentTarget.value)} />}
            <Text size="xs" c="dimmed">
              {repeat === "after"
                ? "The next one is due that long after this one is checked off."
                : repeat === "none"
                  ? " "
                  : "The next one's date doesn't depend on when this one is done. Only one is ever open, so missed ones don't pile up."}
            </Text>
          </Stack>
        )}

        {rights.assign && options.people.length > 0 && <MultiSelect label="Assigned to" data={people} value={assignees} onChange={setAssignees} searchable clearable />}

        {rights.visibility && (
          <Switch
            label="Private"
            description={isPrivate ? "Only you, and anyone you share it with or assign it to." : "Everyone in the space can see this."}
            checked={isPrivate}
            onChange={(e) => setPrivate(e.currentTarget.checked)}
          />
        )}
        {rights.share && isPrivate && options.people.length > 0 && <MultiSelect label="Shared with" data={people} value={shared} onChange={setShared} searchable clearable />}

        <Group>
          <Button type="submit" loading={busy} disabled={!title.trim()}>
            {saveLabel}
          </Button>
          {onCancel && (
            <Button variant="default" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </Group>
      </Stack>

      <Modal opened={picking} onClose={() => setPicking(false)} title="Tap where it is" size="xl" centered>
        <Stack gap="sm">
          {options.maps.length > 1 && (
            <Select allowDeselect={false} aria-label="Map" data={options.maps.map((m) => ({ value: m.id, label: m.name }))} value={mapId} onChange={(v) => setMapId(v ?? mapId)} />
          )}
          {map && (
            <SiteMap
              map={map}
              selected={point?.mapId === map.id ? point : null}
              onPoint={(x, y) => {
                setPoint({ mapId: map.id, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
                setZoneId("");
                setPicking(false);
              }}
            />
          )}
          {map?.places.length ? (
            <Group gap={6}>
              {map.places.map((p) => (
                <Button
                  key={p.id}
                  size="compact-sm"
                  variant="default"
                  onClick={() => {
                    setPoint({ mapId: map.id, x: p.x, y: p.y });
                    setZoneId("");
                    setPicking(false);
                  }}
                >
                  {p.name}
                </Button>
              ))}
            </Group>
          ) : null}
        </Stack>
      </Modal>
    </form>
  );
}
