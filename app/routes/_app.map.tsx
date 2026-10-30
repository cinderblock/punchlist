import { Anchor, Button, Card, Group, Select, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

import { requireViewer } from "../auth.server.ts";
import { SiteMap } from "../components/site-map.tsx";
import { pageTitle } from "../meta.ts";
import { mapPageData } from "../tasks.server.ts";
import type { Route } from "./+types/_app.map";

export function loader({ request, context }: Route.LoaderArgs) {
  return mapPageData(requireViewer(context, request));
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Map");
}

export default function MapPage({ loaderData }: Route.ComponentProps) {
  const { tasks, maps, zones, today } = loaderData;
  const navigate = useNavigate();
  const [mapId, setMapId] = useState(maps[0]?.id ?? "");
  const map = maps.find((m) => m.id === mapId);

  const countIn = (zoneId: string) => tasks.filter((t) => t.location?.zoneId === zoneId).length;

  if (!map) {
    return (
      <Stack maw={720} mx="auto" gap="md">
        <Title order={1} size="h2">
          Zones
        </Title>
        {zones.length === 0 ? (
          <Text c="dimmed">This space has no map or zones set up. They live in the deployment's config file.</Text>
        ) : (
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
            {zones.map((z) => (
              <Card key={z.id} withBorder component={Link} to={`/?zone=${z.id}`}>
                <Text fw={500}>{z.name}</Text>
                <Text size="sm" c="dimmed">
                  {countIn(z.id)} open
                </Text>
              </Card>
            ))}
          </SimpleGrid>
        )}
      </Stack>
    );
  }

  const pins = tasks.flatMap((t) =>
    t.location?.mapId === map.id && t.location.x != null && t.location.y != null
      ? [{ id: t.id, x: t.location.x, y: t.location.y, label: t.title, overdue: t.dueDate != null && t.dueDate < today }]
      : [],
  );
  const unplaced = tasks.filter((t) => t.location?.mapId === map.id && t.location.x == null);

  return (
    <Stack maw={1000} mx="auto" gap="md">
      <Group justify="space-between">
        <Title order={1} size="h2">
          {map.name}
        </Title>
        {maps.length > 1 && <Select aria-label="Map" allowDeselect={false} data={maps.map((m) => ({ value: m.id, label: m.name }))} value={mapId} onChange={(v) => setMapId(v ?? mapId)} />}
      </Group>
      {pins.length === 0 && unplaced.length === 0 && <Text c="dimmed">No open tasks are placed on this map.</Text>}
      <SiteMap map={map} pins={pins} onPin={(id) => navigate(`/tasks/${id}`)} />
      {map.zones.length > 0 && (
        <Group gap={6}>
          {map.zones.map((z) => (
            <Button key={z.id} component={Link} to={`/?zone=${z.id}`} variant="default" size="compact-sm">
              {z.name} ({countIn(z.id)})
            </Button>
          ))}
        </Group>
      )}
      {unplaced.length > 0 && (
        <Stack gap={2}>
          <Text size="sm" c="dimmed">
            In a zone, with no exact spot:
          </Text>
          {unplaced.map((t) => (
            <Anchor key={t.id} component={Link} to={`/tasks/${t.id}`} size="sm">
              {t.title}
            </Anchor>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
