import { Alert, Badge, Button, Card, Checkbox, Code, CopyButton, Group, SegmentedControl, Stack, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import { userActor } from "../../src/actors.ts";
import { SCOPES, type Scope } from "../../src/scopes.ts";
import { createAgent, listAgents, revokeAgent } from "../../src/agents.ts";
import { config } from "../../src/config.server.ts";
import { AGENT_NAME_MAX_LENGTH } from "../../src/limits.ts";
import { handleForm, stringField } from "../actions.server.ts";
import { requireUser } from "../auth.server.ts";
import { useActionFeedback } from "../components/use-action-feedback.ts";
import { pageTitle } from "../meta.ts";
import { whenText } from "../views.server.ts";
import type { Route } from "./+types/_app.settings.agents";

export function loader({ request, context }: Route.LoaderArgs) {
  const { user } = requireUser(context, request);
  return {
    baseUrl: config.publicBaseUrl,
    agents: listAgents(user.id).map((a) => ({
      id: a.id,
      name: a.name,
      scopes: a.scopes,
      added: whenText(a.createdAt),
      lastUsed: a.lastUsedAt ? whenText(a.lastUsedAt) : "never",
      revoked: a.revokedAt != null,
    })),
  };
}

export function meta({ matches }: Route.MetaArgs) {
  return pageTitle(matches, "Agents");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { user } = requireUser(context, request);
  return handleForm(request, {
    create: (form) => {
      const { token, agent } = createAgent({ ownerUserId: user.id, name: stringField(form, "name"), scopes: form.getAll("scopes"), actorUserId: user.id });
      return { ok: true, token, name: agent.name };
    },
    revoke: (form) => {
      revokeAgent({ id: stringField(form, "id"), actor: userActor(user) });
      return { ok: true, message: "Agent revoked. Its token has stopped working." };
    },
  });
}

const SCOPE_TEXT: Record<Scope, string> = {
  "tasks:read": "See public tasks",
  "tasks:write": "Add and edit tasks",
  "tasks:complete": "Check off and reopen tasks",
  "private:read": "See your private tasks",
  "private:write": "Change your private tasks",
  "attachments:write": "Attach files",
};

const DEFAULT_SCOPES: readonly Scope[] = ["tasks:read", "tasks:write", "tasks:complete"];

function setupCommand(baseUrl: string, token: string, shell: "bash" | "powershell"): string {
  const mcp = `claude mcp add --transport http punchlist ${baseUrl}/mcp --header "Authorization: Bearer ${token}"`;
  return shell === "bash"
    ? `${mcp}\nmkdir -p ~/.claude/skills/punchlist && curl -fsSL ${baseUrl}/skill/SKILL.md -o ~/.claude/skills/punchlist/SKILL.md`
    : `${mcp}\nNew-Item -ItemType Directory -Force "$HOME\\.claude\\skills\\punchlist" | Out-Null; Invoke-WebRequest ${baseUrl}/skill/SKILL.md -OutFile "$HOME\\.claude\\skills\\punchlist\\SKILL.md"`;
}

export default function Agents({ loaderData }: Route.ComponentProps) {
  const { baseUrl, agents } = loaderData;
  const create = useFetcher<{ ok: boolean; token?: string; name?: string; error?: string }>();
  const revoke = useFetcher();
  useActionFeedback(create.data);
  useActionFeedback(revoke.data);
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [shell, setShell] = useState<"bash" | "powershell">("bash");
  useEffect(() => {
    if (create.data?.token) setFresh({ token: create.data.token, name: create.data.name ?? "" });
  }, [create.data]);

  const live = agents.filter((a) => !a.revoked);

  return (
    <Stack gap="lg" maw={720} mx="auto">
      <Stack gap={4}>
        <Title order={1} size="h2">
          Agents
        </Title>
        <Text size="sm" c="dimmed">
          An agent gets its own token and shows up under its own name, as "name, for you". It can do what its scopes allow and you can do, and never more. Agents can't delete tasks, or do anything an admin
          does. If you're deactivated, so are they.
        </Text>
      </Stack>

      {fresh && (
        <Alert color="blue" title={`Set up ${fresh.name}`} withCloseButton onClose={() => setFresh(null)}>
          <Stack gap="xs">
            <Text size="sm">Run this where the agent runs. It connects Punchlist and installs the skill. This is the only time the token is shown.</Text>
            <SegmentedControl
              size="xs"
              value={shell}
              onChange={(v) => setShell(v as "bash" | "powershell")}
              data={[
                { value: "bash", label: "macOS, Linux" },
                { value: "powershell", label: "Windows" },
              ]}
            />
            <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }} data-testid="setup-command">
              {setupCommand(baseUrl, fresh.token, shell)}
            </Code>
            <Group>
              <CopyButton value={setupCommand(baseUrl, fresh.token, shell)}>
                {({ copied, copy }) => (
                  <Button size="xs" variant={copied ? "filled" : "light"} onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </CopyButton>
              <CopyButton value={fresh.token}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="default" onClick={copy}>
                    {copied ? "Copied" : "Copy just the token"}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Stack>
        </Alert>
      )}

      {live.length === 0 ? (
        <Text c="dimmed">No agents yet.</Text>
      ) : (
        <Stack gap="sm">
          {live.map((a) => (
            <Card key={a.id} withBorder padding="sm" data-testid="agent">
              <Group justify="space-between" wrap="nowrap" align="start">
                <Stack gap={4}>
                  <Text fw={500}>{a.name}</Text>
                  <Group gap={4}>
                    {a.scopes.map((s) => (
                      <Badge key={s} size="sm" variant="light" tt="none">
                        {s}
                      </Badge>
                    ))}
                  </Group>
                  <Text size="xs" c="dimmed">
                    Added {a.added}, last used {a.lastUsed}
                  </Text>
                </Stack>
                <Button size="xs" variant="subtle" color="red" onClick={() => revoke.submit({ intent: "revoke", id: a.id }, { method: "post" })}>
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
              New agent
            </Title>
            <TextInput name="name" label="Name" placeholder="Claude Code" required maxLength={AGENT_NAME_MAX_LENGTH} />
            <Stack gap={6}>
              <Text size="sm" fw={500}>
                It may
              </Text>
              {SCOPES.map((s) => (
                <Checkbox key={s} name="scopes" value={s} label={SCOPE_TEXT[s]} defaultChecked={DEFAULT_SCOPES.includes(s)} />
              ))}
            </Stack>
            <Group>
              <Button type="submit" loading={create.state !== "idle"}>
                Create agent
              </Button>
            </Group>
          </Stack>
        </create.Form>
      </Card>
    </Stack>
  );
}
