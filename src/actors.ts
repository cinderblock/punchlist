import { site } from "./config.server.ts";
import { SCOPES, type Scope, isScope } from "./scopes.ts";
import type { Role, User } from "./users.ts";

/**
 * Who is doing something. Every front end turns a request into one of these
 * and hands it to the domain layer; nothing below that line looks at cookies,
 * headers or tokens.
 *
 *   user         a person with a passkey
 *   agent        a named credential owned by one user
 *   lan_device   an anonymous browser on the perimeter
 *   integration  a service declared in the config file
 *   system       the app itself (recurring schedules)
 *   nobody       a signed-out visitor from the internet: no rights at all
 */

export { SCOPES, type Scope, isScope };

export interface UserActor {
  kind: "user";
  userId: number;
  name: string;
  role: Role;
}

export interface AgentActor {
  kind: "agent";
  agentId: string;
  name: string;
  ownerUserId: number;
  ownerName: string;
  scopes: readonly Scope[];
}

export interface LanDeviceActor {
  kind: "lan_device";
  deviceId: string;
  /** Self-typed and unverified. Never maps to a user. */
  deviceName: string | null;
}

export interface IntegrationActor {
  kind: "integration";
  integrationId: string;
  name: string;
  scopes: readonly Scope[];
  /** The channel the audit trail records. */
  via: string;
}

export interface SystemActor {
  kind: "system";
}

export interface NobodyActor {
  kind: "nobody";
}

export type Actor = UserActor | AgentActor | LanDeviceActor | IntegrationActor | SystemActor | NobodyActor;

export const NOBODY: NobodyActor = { kind: "nobody" };
export const SYSTEM: SystemActor = { kind: "system" };

export function userActor(user: Pick<User, "id" | "name" | "role">): UserActor {
  return { kind: "user", userId: user.id, name: user.name, role: user.role };
}

/** The stable id events and `created_by` record. */
export function actorId(actor: Actor): string {
  switch (actor.kind) {
    case "user":
      return `user:${actor.userId}`;
    case "agent":
      return `agent:${actor.agentId}`;
    case "lan_device":
      return `lan:${actor.deviceId}`;
    case "integration":
      return `integration:${actor.integrationId}`;
    case "system":
      return "system";
    case "nobody":
      return "nobody";
  }
}

/** How the actor is shown, everywhere: "Claude Code, for Cameron". */
export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case "user":
      return actor.name;
    case "agent":
      return `${actor.name}, for ${actor.ownerName}`;
    case "lan_device": {
      const device = site().onSiteLabel;
      return actor.deviceName ? `${device}, "${actor.deviceName}" (unverified)` : device;
    }
    case "integration":
      return actor.name;
    case "system":
      return "Recurring schedule";
    case "nobody":
      return "Nobody";
  }
}

/** The person this acts for, recorded as `on_behalf_of`. */
export function onBehalfOf(actor: Actor): string | null {
  return actor.kind === "agent" ? `user:${actor.ownerUserId}` : null;
}

/** The person whose private list this actor can reach, if any. */
export function personOf(actor: Actor): number | null {
  if (actor.kind === "user") return actor.userId;
  if (actor.kind === "agent") return actor.ownerUserId;
  return null;
}

/** The default channel a request from this actor came through. */
export function defaultVia(actor: Actor): string {
  switch (actor.kind) {
    case "user":
    case "lan_device":
      return "ui";
    case "integration":
      return actor.via;
    case "system":
      return "schedule";
    default:
      return "api";
  }
}
