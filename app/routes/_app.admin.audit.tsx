import { Alert, Stack, Table, Text, Title } from "@mantine/core";

import { recentAudit } from "../../src/audit.ts";
import { requireAdmin } from "../auth.server.ts";
import { pageTitle } from "../meta.ts";
import { whenText } from "../views.server.ts";
import type { Route } from "./+types/_app.admin.audit";

/**
 * Who did what to accounts, passkeys, agents and feeds. Task history is on each
 * task and under Activity, where it's filtered by what the reader can see, so
 * being an admin doesn't open a side door into private tasks.
 */
export function loader({ request, context }: Route.LoaderArgs) {
  requireAdmin(context, request);
  return {
    rows: recentAudit().map((a) => ({
      id: a.id,
      when: whenText(a.at),
      who: a.actor_name ?? "The app",
      what: `${a.entity} ${a.action}`,
      target: a.entity_id,
    })),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Audit");
}

export default function Audit({ loaderData }: Route.ComponentProps) {
  return (
    <Stack gap="md" maw={900} mx="auto">
      <Title order={1} size="h2">
        Audit
      </Title>
      <Alert color="gray">Accounts, passkeys, agents and feeds. Task history lives on each task, and under Activity.</Alert>
      {loaderData.rows.length === 0 ? (
        <Text c="dimmed">Nothing yet.</Text>
      ) : (
        <Table.ScrollContainer minWidth={520}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Who</Table.Th>
                <Table.Th>What</Table.Th>
                <Table.Th>On</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {loaderData.rows.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>{r.when}</Table.Td>
                  <Table.Td>{r.who}</Table.Td>
                  <Table.Td>{r.what}</Table.Td>
                  <Table.Td>{r.target}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}
