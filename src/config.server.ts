import { createECDH } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { type SiteConfig, describeConfigError, parseSiteConfig } from "./config-schema.ts";

/**
 * Runtime configuration, read once at startup.
 *
 * Two sources, on purpose. The environment holds what belongs to the process
 * and its secrets (where to listen, what to sign with). The one YAML file at
 * CONFIG_FILE holds what belongs to the space (its name, zones, maps,
 * integrations) and is validated against src/config-schema.ts.
 *
 * Deliberately free of any deployment-specific default: this repo ships as a
 * generic app, and every name, hostname and credential arrives from outside.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function nonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number (got ${JSON.stringify(raw)})`);
  return value;
}

/**
 * PUBLIC_BASE_URL must be exactly the origin browsers see: scheme and host, no
 * path, no trailing slash, no default port, lower case. Passkeys are bound to
 * it and a near miss fails as an opaque browser error, so anything else
 * refuses to start.
 */
export function publicOrigin(raw: string): string {
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    // reported below
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== raw) {
    throw new Error(
      `PUBLIC_BASE_URL must be just the origin, like https://todo.example.com, with no path or trailing slash (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

function vapidSubject(raw: string): string | null {
  return /^(https:\/\/|mailto:)\S+$/.test(raw) ? raw : null;
}

/**
 * The VAPID key pair, from the private key alone if need be: the public key is
 * derived from it, so a deployment can generate one random 32-byte secret and
 * nothing else. A public key given alongside must be the private key's own; a
 * mismatched pair is refused every message by every push service.
 */
export function vapidKeys(
  publicRaw: string | undefined,
  privateRaw: string | undefined,
): { publicKey: string; privateKey: string } | { problem: string } | null {
  if (!privateRaw) return publicRaw ? { problem: "VAPID_PUBLIC_KEY is set without VAPID_PRIVATE_KEY" } : null;
  const secret = Buffer.from(privateRaw, "base64url");
  if (secret.length !== 32) return { problem: "VAPID_PRIVATE_KEY must be 32 bytes, base64url-encoded" };
  let derived: string;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(secret);
    derived = ecdh.getPublicKey("base64url");
  } catch {
    return { problem: "VAPID_PRIVATE_KEY isn't a valid P-256 private key" };
  }
  if (publicRaw && publicRaw !== derived) {
    return { problem: "VAPID_PUBLIC_KEY doesn't belong to VAPID_PRIVATE_KEY (leave it unset; it's derived)" };
  }
  // Re-encoded, so a generated value with spare trailing bits reads canonically.
  return { publicKey: derived, privateKey: secret.toString("base64url") };
}

const vapid = vapidKeys(process.env.VAPID_PUBLIC_KEY || undefined, process.env.VAPID_PRIVATE_KEY || undefined);

/**
 * Load the deployment file. Missing means defaults and no map, so a new space
 * can try the app in one command. Anything else that isn't a valid file stops
 * the server here: running with half a config is worse than not running.
 */
export function loadSiteConfig(path: string): SiteConfig {
  if (!existsSync(path)) return parseSiteConfig(undefined);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Config file ${path} isn't valid YAML:\n  ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseSiteConfig(parsed);
  } catch (err) {
    throw new Error(`Config file ${path} is invalid:\n${describeConfigError(err)}`);
  }
}

/** Header names no reverse proxy could safely dedicate to this. */
const RESERVED_HEADERS = new Set(["host", "cookie", "authorization", "origin", "referer", "content-type", "content-length", "user-agent"]);

/**
 * The header that marks a request as on site. It must be a plain header name
 * of its own: pointing it at one a client always controls would hand out the
 * anonymous tier to anybody.
 */
export function perimeterHeader(raw: string | undefined, variable = "TRUSTED_PERIMETER_HEADER"): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(value) || RESERVED_HEADERS.has(value.toLowerCase())) {
    throw new Error(`${variable} must be a dedicated header name (got ${JSON.stringify(raw)})`);
  }
  return value.toLowerCase();
}

/** Where a browser's push subscription may point, when config doesn't say. A leading dot means any subdomain. */
const DEFAULT_PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

function pushHosts(raw: string | undefined): string[] {
  const hosts = raw
    ?.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts?.length ? hosts : DEFAULT_PUSH_HOSTS;
}

const configFile = process.env.CONFIG_FILE || "/config/punchlist.yaml";
const siteFile = loadSiteConfig(configFile);
const databasePath = process.env.DATABASE_PATH ?? "./data/punchlist.db";

export const config = {
  /** The deployment file, validated. Read it through site() below. */
  configFile,
  site: siteFile,

  /**
   * Public origin the app is served from. Load-bearing beyond cosmetics: it is
   * the WebAuthn RP ID, the expected Origin of every mutation, and the base for
   * one-time links.
   */
  publicBaseUrl: publicOrigin(required("PUBLIC_BASE_URL")),

  /** Where the SQLite file lives. The container bind-mounts /data. */
  databasePath,
  attachmentsDir: process.env.ATTACHMENTS_DIR || join(dirname(resolve(databasePath)), "attachments"),

  port: Number(process.env.PORT ?? 3000),
  /** When set, listen on this unix socket instead of `port`. */
  socketPath: process.env.SOCKET_PATH || null,

  /**
   * Lower-cased name of the header that grants the anonymous on-site tier, or
   * null for no such tier at all. Read it through trustedPerimeterHeader().
   */
  perimeterHeader: perimeterHeader(process.env.TRUSTED_PERIMETER_HEADER),

  /**
   * Lower-cased name of a header the proxy overwrites with the client's address,
   * or null. Used only to give passkey ceremonies a rate limit per address. It
   * never feeds a permission. Read it through trustedClientIpHeader().
   */
  clientIpHeader: perimeterHeader(process.env.TRUSTED_CLIENT_IP_HEADER, "TRUSTED_CLIENT_IP_HEADER"),

  /** Every date and time, shown and judged. The config file wins over TZ. */
  timezone: siteFile.timezone ?? process.env.TZ ?? "UTC",

  push: {
    // Web Push (VAPID). Optional and fail-soft: with no usable key, push is
    // disabled, the settings page says so and the server never sends.
    vapidPublicKey: vapid && "publicKey" in vapid ? vapid.publicKey : null,
    vapidPrivateKey: vapid && "privateKey" in vapid ? vapid.privateKey : null,
    /** Why the keys given can't be used, for the startup log. */
    vapidProblem: vapid && "problem" in vapid ? vapid.problem : null,
    /**
     * Who push services contact about this sender: a mailto: or https: URL
     * (anything else, and they refuse every message). Defaults to the site's
     * own address when that is https.
     */
    vapidSubject: vapidSubject(process.env.VAPID_SUBJECT || process.env.PUBLIC_BASE_URL || ""),
    /** How often reminders are checked for, in seconds. 0 turns them off (tests still send). */
    checkEverySeconds: nonNegativeInt("NOTIFY_EVERY_SECONDS", 60),
    /**
     * The hosts a subscription may name. The server makes the request, so without
     * this a signed-in person could point it at anything it can reach.
     */
    endpointHosts: pushHosts(process.env.PUSH_ENDPOINT_HOSTS),
  },

  /**
   * Signs cookies. Required: there is no safe default, and a generated-at-boot
   * fallback would silently log everyone out on every deploy.
   */
  sessionSecret: required("SESSION_SECRET"),
};

// ---- test seams ----------------------------------------------------------------------

type Overrides = { site?: SiteConfig; perimeterHeader?: string | null; clientIpHeader?: string | null };
type GlobalWithOverrides = typeof globalThis & { __punchlistConfigOverrides__?: Overrides };

/** The deployment's config. A function so tests can swap in a map. */
export function site(): SiteConfig {
  return (globalThis as GlobalWithOverrides).__punchlistConfigOverrides__?.site ?? config.site;
}

/** The perimeter header's name, or null when there's no anonymous tier. */
export function trustedPerimeterHeader(): string | null {
  const overrides = (globalThis as GlobalWithOverrides).__punchlistConfigOverrides__;
  return overrides && "perimeterHeader" in overrides ? (overrides.perimeterHeader ?? null) : config.perimeterHeader;
}

/** The client-address header's name, or null when there isn't one to trust. */
export function trustedClientIpHeader(): string | null {
  const overrides = (globalThis as GlobalWithOverrides).__punchlistConfigOverrides__;
  return overrides && "clientIpHeader" in overrides ? (overrides.clientIpHeader ?? null) : config.clientIpHeader;
}

export function setConfigForTests(overrides: Overrides | undefined): void {
  (globalThis as GlobalWithOverrides).__punchlistConfigOverrides__ = overrides;
}

/** The resolved settings that aren't secret, for the log at startup. */
export function describeConfig(): string {
  const s = site();
  const p = config.push;
  const header = trustedPerimeterHeader();
  return [
    "Configuration:",
    `  PUBLIC_BASE_URL     ${config.publicBaseUrl}`,
    `  listening on        ${config.socketPath ? `unix:${config.socketPath}` : `port ${config.port}`}`,
    `  config file         ${config.configFile}${existsSync(config.configFile) ? "" : " (not found: defaults, no map)"}`,
    `  space               ${s.name}, ${s.maps.length} map(s), ${s.zones.length + s.maps.reduce((n, m) => n + m.zones.length, 0)} zone(s)`,
    `  time zone           ${config.timezone}`,
    `  on-site tier        ${header ? `on, from header ${header}` : "off (TRUSTED_PERIMETER_HEADER unset)"}`,
    `  ceremony limits     ${trustedClientIpHeader() ? `per address, from header ${trustedClientIpHeader()}` : "shared (TRUSTED_CLIENT_IP_HEADER unset)"}`,
    `  web push            ${
      p.vapidProblem
        ? `OFF: ${p.vapidProblem}`
        : !p.vapidPrivateKey
          ? "off (no VAPID_PRIVATE_KEY)"
          : !p.vapidSubject
            ? "OFF: VAPID_SUBJECT must be an https: or mailto: URL (PUBLIC_BASE_URL is used when it is https)"
            : `on, reminders ${p.checkEverySeconds ? `checked every ${p.checkEverySeconds}s` : "off"}`
    }`,
  ].join("\n");
}
