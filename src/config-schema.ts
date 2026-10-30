import { z } from "zod";

import { pointInPolygon } from "./geometry.ts";

/**
 * The schema of the deployment file (CONFIG_FILE, by default
 * /config/punchlist.yaml). This is the published contract between the generic
 * image and whoever runs it; `README.md` documents it and
 * `examples/punchlist.yaml` is a worked example.
 *
 * Everything is optional, so a missing file and an empty file both give a
 * working, unbranded app with no map. Unknown keys are refused rather than
 * ignored: a typo in a config file should stop the deploy, not quietly do
 * nothing.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lower-case letters, digits, - and _ (start with a letter or digit)");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like "#2f9e44"');
const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** A point in the map's own units. */
const point = z.tuple([z.number().finite(), z.number().finite()]);
const polygon = z.array(point).min(3, "a polygon needs at least 3 points");

const flatZone = z.strictObject({
  id,
  name: z.string().min(1).max(80),
});

const mapZone = flatZone.extend({
  /** The area this zone covers, in the map's units. */
  polygon,
  /** Fill colour on the map. */
  color: hexColor.optional(),
});

const place = z.strictObject({
  id,
  name: z.string().min(1).max(80),
  x: z.number().finite(),
  y: z.number().finite(),
});

const map = z.strictObject({
  id,
  name: z.string().min(1).max(80),
  /** Shown beside coordinates ("ft", "m"). Nothing is converted. */
  units: z.string().min(1).max(16).default("m"),
  /** The building's outline, in the map's units. Its bounding box is the map's extent. */
  outline: polygon,
  /** Which way y grows on screen: "up" for surveyed coordinates, "down" for image-like ones. */
  yAxis: z.enum(["up", "down"]).default("up"),
  zones: z.array(mapZone).default([]),
  places: z.array(place).default([]),
});

const label = z.strictObject({
  name: z.string().min(1).max(40),
  color: hexColor.optional(),
});

/** A subset of src/scopes.ts: an integration has no owner, so nothing private. */
const integrationScope = z.enum(["tasks:read", "tasks:write", "tasks:complete"]);

const integration = z.strictObject({
  id,
  /** Who the app says did it, everywhere: "Monitoring". */
  name: z.string().min(1).max(80),
  /**
   * The name of the environment variable holding this integration's bearer
   * token. The token itself never goes in this file. Unset or too short at
   * boot: the integration stays off, and the log says so.
   */
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable name"),
  scopes: z.array(integrationScope).min(1).default(["tasks:read", "tasks:write", "tasks:complete"]),
  /** What the audit trail records as the channel. Defaults to "api". */
  via: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .default("api"),
});

export const siteConfigSchema = z
  .strictObject({
    name: z.string().min(1).max(60).default("Punchlist"),
    /** Under the home-screen icon; 12 characters fit every launcher. */
    shortName: z.string().min(1).max(12).default("Punchlist"),
    themeColor: hexColor.default("#2f9e44"),
    /** An inline SVG document. Served as an image, so scripts in it don't run. */
    logoSvg: z.string().max(200_000).optional(),
    /** IANA zone every date and time in the app is shown and judged in. */
    timezone: z.string().refine(validZone, "an IANA time zone like America/Chicago").optional(),
    /** What an anonymous on-site browser is called, in lists and audit: "Shop device". */
    onSiteLabel: z.string().min(1).max(40).default("On-site device"),
    /** Named zones with no map behind them. A space with no map just uses these. */
    zones: z.array(flatZone).default([]),
    /** Seeded once; after that, admins manage labels in the app. */
    labels: z.array(label).default([]),
    maps: z.array(map).default([]),
    integrations: z.array(integration).default([]),
  })
  .superRefine((site, ctx) => {
    const flag = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const unique = (values: string[], path: (string | number)[], what: string) => {
      const seen = new Set<string>();
      values.forEach((value, i) => {
        const key = value.toLowerCase();
        if (seen.has(key)) flag([...path, i], `duplicate ${what} "${value}"`);
        seen.add(key);
      });
    };

    unique(site.labels.map((l) => l.name), ["labels"], "label");
    unique(site.maps.map((m) => m.id), ["maps"], "map id");
    unique(site.integrations.map((i) => i.id), ["integrations"], "integration id");

    // Zone ids share one namespace: tasks and watches refer to a zone by id alone.
    const zoneIds = [...site.zones.map((z) => z.id), ...site.maps.flatMap((m) => m.zones.map((z) => z.id))];
    unique(zoneIds, ["zones"], "zone id");

    site.maps.forEach((m, mi) => {
      m.places.forEach((p, pi) => {
        if (!pointInPolygon(p.x, p.y, m.outline)) {
          // A place on the wall is normal (doors), so only the bounding box is a hard limit.
          const xs = m.outline.map((pt) => pt[0]);
          const ys = m.outline.map((pt) => pt[1]);
          if (p.x < Math.min(...xs) || p.x > Math.max(...xs) || p.y < Math.min(...ys) || p.y > Math.max(...ys)) {
            flag(["maps", mi, "places", pi], `"${p.name}" is outside the map`);
          }
        }
      });
    });
  });

export type SiteConfig = z.output<typeof siteConfigSchema>;
export type SiteMap = SiteConfig["maps"][number];
export type SiteZone = SiteMap["zones"][number];
export type SitePlace = SiteMap["places"][number];
export type SiteIntegration = SiteConfig["integrations"][number];

export const DEFAULT_SITE: SiteConfig = siteConfigSchema.parse({});

/** Parse already-loaded YAML. A missing or empty document means all defaults. */
export function parseSiteConfig(value: unknown): SiteConfig {
  return siteConfigSchema.parse(value ?? {});
}

/** A zod failure as lines a person can act on. */
export function describeConfigError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `  ${i.path.join(".") || "(top level)"}: ${i.message}`).join("\n");
  }
  return `  ${err instanceof Error ? err.message : String(err)}`;
}
