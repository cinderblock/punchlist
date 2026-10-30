import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSiteConfig, publicOrigin, vapidKeys } from "./config.server.ts";
import { parseSiteConfig } from "./config-schema.ts";
import { pointInPolygon } from "./geometry.ts";

const file = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), "punchlist-config-"));
  const path = join(dir, "punchlist.yaml");
  writeFileSync(path, text);
  return path;
};

describe("the config file", () => {
  test("missing means defaults and no map", () => {
    const site = loadSiteConfig("./no-such-file.yaml");
    expect(site.name).toBe("Punchlist");
    expect(site.maps).toEqual([]);
    expect(site.integrations).toEqual([]);
  });

  test("empty means the same", () => {
    expect(loadSiteConfig(file("")).name).toBe("Punchlist");
    expect(loadSiteConfig(file("# just a comment\n")).name).toBe("Punchlist");
  });

  test("the example in the repo is valid", () => {
    const site = loadSiteConfig("examples/punchlist.yaml");
    expect(site.maps).toHaveLength(1);
    expect(site.maps[0]!.zones.length).toBeGreaterThan(1);
    expect(site.integrations[0]!.tokenEnv).toBe("INTEGRATION_MONITOR_TOKEN");
  });

  test("broken YAML refuses, saying which file", () => {
    const path = file("name: [unclosed");
    expect(() => loadSiteConfig(path)).toThrow(/isn't valid YAML/);
    rmSync(path);
  });

  test("a schema failure refuses, and says where", () => {
    expect(() => loadSiteConfig(file("themeColor: green"))).toThrow(/themeColor/);
    expect(() => loadSiteConfig(file("timezone: Mars/Olympus"))).toThrow(/timezone/);
  });

  test("an unknown key refuses: a typo must not quietly do nothing", () => {
    expect(() => loadSiteConfig(file("nmae: Oops"))).toThrow(/nmae/);
  });

  test("secrets have nowhere to go", () => {
    expect(() => parseSiteConfig({ integrations: [{ id: "x", name: "X", tokenEnv: "X_TOKEN", token: "hunter2" }] })).toThrow();
  });

  test("duplicate ids refuse, across all zones", () => {
    expect(() => parseSiteConfig({ zones: [{ id: "a", name: "A" }, { id: "a", name: "B" }] })).toThrow(/duplicate/);
    const map = (zoneId: string) => ({ id: "m", name: "M", outline: [[0, 0], [1, 0], [1, 1]], zones: [{ id: zoneId, name: "Z", polygon: [[0, 0], [1, 0], [1, 1]] }] });
    expect(() => parseSiteConfig({ zones: [{ id: "a", name: "A" }], maps: [map("a")] })).toThrow(/duplicate/);
  });

  test("a place off the map refuses, and a place on a wall is fine", () => {
    const outline = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(() => parseSiteConfig({ maps: [{ id: "m", name: "M", outline, places: [{ id: "p", name: "P", x: 50, y: 5 }] }] })).toThrow(/outside the map/);
    expect(parseSiteConfig({ maps: [{ id: "m", name: "M", outline, places: [{ id: "p", name: "P", x: 10, y: 5 }] }] }).maps).toHaveLength(1);
  });

  test("a bad polygon refuses", () => {
    expect(() => parseSiteConfig({ maps: [{ id: "m", name: "M", outline: [[0, 0], [1, 1]] }] })).toThrow(/at least 3/);
  });
});

describe("PUBLIC_BASE_URL", () => {
  test("must be a bare origin", () => {
    expect(publicOrigin("https://todo.example.com")).toBe("https://todo.example.com");
    expect(publicOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of ["https://todo.example.com/", "https://todo.example.com/app", "todo.example.com", "https://TODO.example.com", "ftp://todo.example.com", "https://todo.example.com:443", ""]) {
      expect(() => publicOrigin(bad)).toThrow(/just the origin/);
    }
  });
});

describe("VAPID", () => {
  test("the public key is derived from the private one", () => {
    const secret = Buffer.alloc(32, 7).toString("base64url");
    const keys = vapidKeys(undefined, secret);
    expect(keys && "publicKey" in keys).toBe(true);
    expect(vapidKeys(undefined, undefined)).toBeNull();
    expect(vapidKeys(undefined, "short")).toEqual({ problem: expect.stringContaining("32 bytes") });
  });
});

test("point in polygon", () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][];
  expect(pointInPolygon(5, 5, square)).toBe(true);
  expect(pointInPolygon(15, 5, square)).toBe(false);
  const ell = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]] as [number, number][];
  expect(pointInPolygon(7, 7, ell)).toBe(false);
  expect(pointInPolygon(2, 7, ell)).toBe(true);
});
