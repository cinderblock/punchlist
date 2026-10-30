import { type Actor, type AgentActor, type LanDeviceActor, type Scope, SCOPES, type UserActor, userActor } from "../actors.ts";
import { createAgent } from "../agents.ts";
import { deviceCookie, sessionCookie } from "../http/cookies.ts";
import { setConfigForTests } from "../config.server.ts";
import { parseSiteConfig } from "../config-schema.ts";
import { db } from "../db.server.ts";
import { resetRateLimitsForTests } from "../rate-limit.ts";
import { createSession } from "../sessions.ts";
import { createUser } from "../users.ts";
import { freshDb } from "./db.ts";

/** A small space for tests: one map, with two zones. */
export const TEST_SITE = parseSiteConfig({
  name: "Test Space",
  zones: [{ id: "yard", name: "Yard" }],
  labels: [{ name: "maintenance" }, { name: "safety" }],
  maps: [
    {
      id: "shop",
      name: "Shop",
      units: "ft",
      outline: [
        [0, 0],
        [100, 0],
        [100, 50],
        [0, 50],
      ],
      zones: [
        {
          id: "bay-1",
          name: "Bay 1",
          polygon: [
            [0, 0],
            [50, 0],
            [50, 50],
            [0, 50],
          ],
        },
        {
          id: "bay-2",
          name: "Bay 2",
          polygon: [
            [50, 0],
            [100, 0],
            [100, 50],
            [50, 50],
          ],
        },
      ],
      places: [{ id: "door", name: "Door", x: 10, y: 50 }],
    },
  ],
  integrations: [{ id: "monitor", name: "Monitor", tokenEnv: "TEST_INTEGRATION_TOKEN" }],
});

export const INTEGRATION_TOKEN = "a-test-integration-token-of-enough-length";
export const PERIMETER_HEADER = "x-test-perimeter";

export interface World {
  admin: UserActor;
  alice: UserActor;
  bob: UserActor;
  lan: LanDeviceActor;
}

/** A fresh database, the test site, and an admin plus two members. */
export function freshWorld(options: { perimeter?: boolean } = {}): World {
  freshDb();
  setConfigForTests({ site: TEST_SITE, perimeterHeader: options.perimeter === false ? null : PERIMETER_HEADER });
  resetRateLimitsForTests();
  process.env.TEST_INTEGRATION_TOKEN = INTEGRATION_TOKEN;
  db().exec("INSERT INTO labels (name, created_at) VALUES ('maintenance', 0), ('safety', 0)");
  db().exec("INSERT INTO lan_devices (id, created_at, last_seen_at) VALUES ('device-1', 0, 0)");
  const person = (name: string, role: "admin" | "member") => userActor(createUser({ name, role, actorUserId: null }));
  return {
    admin: person("Addie Admin", "admin"),
    alice: person("Alice Member", "member"),
    bob: person("Bob Member", "member"),
    lan: { kind: "lan_device", deviceId: "device-1", deviceName: null },
  };
}

/** An agent with a real token. */
export function agentFor(owner: UserActor, scopes: readonly Scope[] = SCOPES): { actor: AgentActor; token: string } {
  const { agent, token } = createAgent({ ownerUserId: owner.userId, name: "Helper", scopes, actorUserId: owner.userId });
  return {
    token,
    actor: { kind: "agent", agentId: agent.id, name: agent.name, ownerUserId: owner.userId, ownerName: owner.name, scopes: agent.scopes },
  };
}

/** A Cookie header that signs in as this person, the real way. */
export async function sessionHeader(user: UserActor): Promise<string> {
  const { token } = createSession({ userId: user.userId, credentialId: null, userAgent: null });
  const set = await sessionCookie.serialize(token);
  return set.split(";")[0]!;
}

export async function deviceHeader(id = "device-1"): Promise<string> {
  const set = await deviceCookie.serialize(id);
  return set.split(";")[0]!;
}

export const ORIGIN = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

export type { Actor };
