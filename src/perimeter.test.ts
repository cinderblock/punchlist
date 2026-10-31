import { afterEach, describe, expect, test } from "bun:test";

import { config, perimeterHeader, setConfigForTests } from "./config.server.ts";
import { db } from "./db.server.ts";
import { apiFromRequest } from "./http/api.ts";
import { assertSameOrigin } from "./http/guard.ts";
import { isOnSite, resolveRequest } from "./http/resolve-actor.ts";
import { handleMcp } from "./mcp.ts";
import { startEnrollment } from "./auth-flows.ts";
import { createTask } from "./tasks.ts";
import { PERIMETER_HEADER, ORIGIN, agentFor, deviceHeader, freshWorld, sessionHeader } from "./testing/fixtures.ts";

afterEach(() => setConfigForTests(undefined));

const onSite = { [PERIMETER_HEADER]: "lan" };
const tasks = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/v1/tasks`, { headers });
const post = (path: string, headers: Record<string, string>, body: unknown = {}) => new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const json = { "Content-Type": "application/json", Origin: ORIGIN };

describe("with TRUSTED_PERIMETER_HEADER unset", () => {
  test("there's no anonymous tier, and the header means nothing at all", async () => {
    freshWorld({ perimeter: false });
    const request = tasks({ ...onSite, "X-Punchlist-Perimeter": "lan", Cookie: await deviceHeader() });
    expect(isOnSite(request)).toBe(false);
    expect((await resolveRequest(request)).actor.kind).toBe("nobody");
    expect((await apiFromRequest(request)).status).toBe(401);
  });

  test("a default install fails closed: unset reads as no header", () => {
    expect(perimeterHeader(undefined)).toBeNull();
    expect(perimeterHeader("")).toBeNull();
    expect(perimeterHeader("   ")).toBeNull();
    expect(config.perimeterHeader).toBeNull();
  });
});

describe("with TRUSTED_PERIMETER_HEADER set", () => {
  test("the right value on that header makes an anonymous device, with a cookie for next time", async () => {
    freshWorld();
    const resolved = await resolveRequest(tasks(onSite));
    expect(resolved.actor.kind).toBe("lan_device");
    expect(resolved.newDeviceId).toBeTruthy();
    expect((await apiFromRequest(tasks(onSite))).status).toBe(200);
  });

  test("a returning device keeps its identity", async () => {
    freshWorld();
    const resolved = await resolveRequest(tasks({ ...onSite, Cookie: await deviceHeader("device-1") }));
    expect(resolved.actor).toEqual({ kind: "lan_device", deviceId: "device-1", deviceName: null });
    expect(resolved.newDeviceId).toBeNull();
  });

  test("anything but exactly lan is off site", async () => {
    freshWorld();
    for (const value of ["LAN", "true", "1", "lan, lan", "wan", ""]) {
      const request = tasks({ [PERIMETER_HEADER]: value });
      expect((await resolveRequest(request)).actor.kind).toBe("nobody");
    }
  });

  test("a different header proves nothing", async () => {
    freshWorld();
    expect((await resolveRequest(tasks({ "X-Forwarded-For": "10.0.0.5", "X-Real-IP": "10.0.0.5", "Cf-Connecting-Ip": "10.0.0.5" }))).actor.kind).toBe("nobody");
  });

  test("a failed token is nobody even on site: the tier isn't a fallback for a bad credential", async () => {
    freshWorld();
    for (const value of ["Bearer pl_000000000000_notarealtoken", "Bearer nonsense", "Basic abc", ""]) {
      const request = tasks({ ...onSite, Authorization: value });
      expect((await resolveRequest(request)).actor.kind).toBe("nobody");
      expect((await apiFromRequest(request)).status).toBe(401);
    }
  });

  test("a signed-in person on site is that person, not a device", async () => {
    const w = freshWorld();
    const resolved = await resolveRequest(tasks({ ...onSite, Cookie: await sessionHeader(w.alice) }));
    expect(resolved.actor.kind).toBe("user");
  });
});

describe("the one thing a signed-out visitor can do", () => {
  const report = (headers: Record<string, string>) => post("/api/v1/errors", headers, { where: "window", name: "Error", message: "Boom" });

  test("is report an error, from our own pages", async () => {
    freshWorld({ perimeter: false });
    expect((await apiFromRequest(report(json))).status).toBe(202);
  });

  test("not from anywhere else", async () => {
    freshWorld({ perimeter: false });
    expect((await apiFromRequest(report({ "Content-Type": "application/json", Origin: "https://evil.example" }))).status).toBe(403);
    expect((await apiFromRequest(report({ "Content-Type": "text/plain", Origin: ORIGIN }))).status).toBe(415);
  });

  test("a credential that failed is still 401: it's not a fallback", async () => {
    freshWorld({ perimeter: false });
    expect((await apiFromRequest(report({ ...json, Authorization: "Bearer nonsense" }))).status).toBe(401);
  });

  test("and nothing next to it", async () => {
    freshWorld({ perimeter: false });
    expect((await apiFromRequest(post("/api/v1/feedback", json, { kind: "bug", body: "Hello" }))).status).toBe(401);
    expect((await apiFromRequest(new Request(`${ORIGIN}/api/v1/feedback/images/x`))).status).toBe(401);
  });
});

describe("the on-site tier never reaches further than the anonymous tier", () => {
  test("not private tasks", async () => {
    const w = freshWorld();
    const { task } = createTask(w.alice, { title: "Private", visibility: "private" });
    const response = await apiFromRequest(new Request(`${ORIGIN}/api/v1/tasks/${task.id}`, { headers: onSite }));
    expect(response.status).toBe(404);
  });

  test("not agent powers: /mcp wants a token", async () => {
    freshWorld();
    const response = await handleMcp(post("/mcp", { ...onSite, ...json }));
    expect(response.status).toBe(401);
  });

  test("not admin, not enrolment: a passkey needs a link or a session", async () => {
    freshWorld();
    await expect(startEnrollment({ intent: "self", joinToken: null, currentUser: null, name: "Walk-in" })).rejects.toThrow(/Sign in first/);
    expect((await resolveRequest(tasks(onSite))).user).toBeNull();
    expect((await resolveRequest(tasks(onSite))).session).toBeNull();
  });
});

describe("anonymous mutations need a same-origin Origin and JSON", () => {
  const create = (headers: Record<string, string>) => post("/api/v1/tasks", { ...onSite, ...headers }, { title: "From a page" });

  test("allowed from our own pages", async () => {
    freshWorld();
    expect((await apiFromRequest(create(json))).status).toBe(201);
  });

  test("refused from another origin", async () => {
    freshWorld();
    expect((await apiFromRequest(create({ "Content-Type": "application/json", Origin: "https://evil.example" }))).status).toBe(403);
  });

  test("refused with no Origin at all", async () => {
    freshWorld();
    expect((await apiFromRequest(create({ "Content-Type": "application/json" }))).status).toBe(403);
  });

  test("refused as a form post, which is what a cross-site form can send", async () => {
    freshWorld();
    for (const type of ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]) {
      expect((await apiFromRequest(create({ "Content-Type": type, Origin: ORIGIN }))).status).toBe(415);
    }
  });

  test("the same goes for a signed-in cookie, which is just as ambient", async () => {
    const w = freshWorld();
    const cookie = await sessionHeader(w.alice);
    const response = await apiFromRequest(post("/api/v1/tasks", { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: cookie }, { title: "x" }));
    expect(response.status).toBe(403);
  });

  test("a token isn't ambient, so a script needs no Origin", async () => {
    const w = freshWorld();
    const response = await apiFromRequest(post("/api/v1/tasks", { Authorization: `Bearer ${agentFor(w.alice).token}` }, { title: "From a script" }));
    expect(response.status).toBe(201);
  });

  test("assertSameOrigin compares against PUBLIC_BASE_URL, not the request's own host", () => {
    const request = new Request("http://evil.example/api", { method: "POST", headers: { Origin: "http://evil.example", Host: "evil.example" } });
    expect(() => assertSameOrigin(request)).toThrow();
  });
});

describe("TRUSTED_PERIMETER_HEADER itself", () => {
  test("can't be pointed at a header every client controls", () => {
    for (const name of ["Cookie", "Host", "Authorization", "Origin", "User-Agent", "not a header", "x:y"]) {
      expect(() => perimeterHeader(name)).toThrow();
    }
    expect(perimeterHeader("X-Punchlist-Perimeter")).toBe("x-punchlist-perimeter");
  });
});

describe("what an anonymous device can cost", () => {
  test("a body has a limit", async () => {
    freshWorld();
    const big = post("/api/v1/tasks", { ...onSite, ...json }, { title: "x", details: "y".repeat(2 * 1024 * 1024) });
    expect((await apiFromRequest(big)).status).toBe(413);
  });

  test("a client that keeps dropping its cookie leaves no rows behind", async () => {
    freshWorld();
    const count = () => db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lan_devices").get()!.n;
    const before = count();
    for (let i = 0; i < 5; i++) await apiFromRequest(tasks(onSite));
    expect(count()).toBe(before);
  });

  test("a device that names itself gets a row, and keeps the name", async () => {
    freshWorld();
    const resolved = await resolveRequest(tasks(onSite));
    const id = resolved.newDeviceId!;
    const rename = new Request(`${ORIGIN}/api/v1/device`, { method: "PATCH", headers: { ...onSite, ...json, Cookie: await deviceHeader(id) }, body: JSON.stringify({ name: "Sam" }) });
    expect(((await (await apiFromRequest(rename)).json()) as { label: string }).label).toBe('On-site device, "Sam" (unverified)');
    const again = await resolveRequest(tasks({ ...onSite, Cookie: await deviceHeader(id) }));
    expect(again.actor).toMatchObject({ kind: "lan_device", deviceName: "Sam" });
  });

  test("a mangled dedupe key is a bad request, not a crash", async () => {
    const w = freshWorld();
    const response = await apiFromRequest(post("/api/v1/dedupe/%E0%A4%A/complete", { Authorization: `Bearer ${agentFor(w.alice).token}` }));
    expect(response.status).toBe(400);
  });
});
