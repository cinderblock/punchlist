import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UNSAFE_ErrorResponseImpl as ErrorResponse } from "react-router";
import sharp from "sharp";

import { auditFor } from "./audit.ts";
import { config, setConfigForTests } from "./config.server.ts";
import { db } from "./db.server.ts";
import { countOpenErrors, fingerprintOf, listErrorGroups, reportClientError, reportServerError, setErrorStatus, worthReporting } from "./error-reports.ts";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError, UserInputError } from "./errors.ts";
import { addFeedbackImage, countOpenReports, deleteFeedback, listFeedback, sendFeedback, serveFeedbackImage, setFeedbackStatus } from "./feedback.ts";
import { apiFromRequest } from "./http/api.ts";
import { addSubscription, setPrefs, unsent } from "./notifications/store.ts";
import { redactPath, redactText } from "./redact.ts";
import { createSession } from "./sessions.ts";
import { mapStack } from "./source-maps.ts";
import { createTask } from "./tasks.ts";
import { type World, ORIGIN, agentFor, freshWorld, sessionHeader } from "./testing/fixtures.ts";
import { uuidv7 } from "./uuid.ts";

let w: World;
let dir: string;

beforeEach(() => {
  w = freshWorld();
  dir = mkdtempSync(join(tmpdir(), "punchlist-reports-"));
  config.attachmentsDir = dir;
});

afterEach(() => {
  setConfigForTests(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const NOBODY = { kind: "nobody" } as const;
const report = (over: Record<string, unknown> = {}) => ({ where: "window", name: "TypeError", message: "x is not a function", ...over });
const note = (over: Record<string, unknown> = {}) => ({ kind: "bug", body: "The button does nothing", ...over });
const groups = () => listErrorGroups(w.admin);

function device(user: World["admin"]) {
  const { session } = createSession({ userId: user.userId, credentialId: null, userAgent: null });
  addSubscription({ userId: user.userId, sessionId: session.id, subscription: { endpoint: `https://push.example.test/${user.userId}`, keys: { p256dh: "abc", auth: "def" } }, userAgent: null });
}

describe("redaction", () => {
  test("a path keeps none of what it was searched with, and no capability", () => {
    expect(redactPath("/?q=my+salary")).toBe("/");
    expect(redactPath("/tasks/abc#comment")).toBe("/tasks/abc");
    expect(redactPath("/join/s3cret-token")).toBe("/join/[redacted]");
    expect(redactPath("/feeds/abc123.ics")).toBe("/feeds/[redacted]");
    expect(redactPath("/settings.data")).toBe("/settings");
    expect(redactPath("/_root.data?_routes=x")).toBe("/");
  });

  test("error text gives up tokens, wherever they are", () => {
    expect(redactText("failed https://host/join/abcdef?x=1 now")).toBe("failed https://host/join/[redacted] now");
    expect(redactText("GET /?q=private+thing failed")).toBe("GET / failed");
    expect(redactText("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]");
    expect(redactText("token pl_0123456789_abcdefghij")).toBe("token [redacted]");
    expect(redactText("cookie=4f9dA8cQ7xZ2mN5bV1kL0pR6tY3wE9uI8oS")).toBe("cookie=[redacted]");
  });

  test("and keeps what a person needs to read it", () => {
    const id = uuidv7();
    expect(redactText(`/tasks/${id}`)).toBe(`/tasks/${id}`);
    expect(redactText("at some-long-kebab-case-file-name-that-goes-on-forever.tsx")).toContain("some-long-kebab");
    expect(redactText("TypeError: Cannot read properties of undefined (reading 'title')")).toBe("TypeError: Cannot read properties of undefined (reading 'title')");
  });
});

describe("errors group by what they are", () => {
  test("the same error again is a count, not a row", () => {
    reportClientError(w.alice, null, report(), "ua");
    reportClientError(w.bob, null, report(), "ua");
    expect(groups()).toHaveLength(1);
    expect(groups()[0]).toMatchObject({ count: 2, who: "Bob Member", status: "open", source: "client:window" });
  });

  test("ids and numbers don't split a group, and a different message does", () => {
    reportClientError(w.alice, null, report({ message: `Task ${uuidv7()} failed after 12 tries` }), null);
    reportClientError(w.alice, null, report({ message: `Task ${uuidv7()} failed after 3 tries` }), null);
    expect(groups()).toHaveLength(1);
    reportClientError(w.alice, null, report({ message: "Something else" }), null);
    expect(groups()).toHaveLength(2);
  });

  test("a new release's content hashes don't split a group", () => {
    const base = { source: "client:window", name: "Error", message: "x", anonymous: false };
    const a = fingerprintOf({ ...base, stack: "Error: x\n    at f (https://h/assets/root-AbCd1234.js:1:200)" });
    const b = fingerprintOf({ ...base, stack: "Error: x\n    at f (https://h/assets/root-ZyXw9876.js:1:912)" });
    const c = fingerprintOf({ ...base, stack: "Error: x\n    at f (https://h/assets/other-ZyXw9876.js:1:912)" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("fixed and happening again is open again, and ignored stays ignored", () => {
    const id = reportClientError(w.alice, null, report(), null)!;
    setErrorStatus(w.admin, id, "resolved");
    reportClientError(w.alice, null, report(), null);
    expect(groups()[0]!.status).toBe("open");
    setErrorStatus(w.admin, id, "ignored");
    reportClientError(w.alice, null, report(), null);
    expect(groups()[0]!.status).toBe("ignored");
  });

  test("a browser can't claim to be the server", () => {
    expect(() => reportClientError(w.alice, null, report({ where: "server:route" }), null)).toThrow();
  });

  test("long text is cut, not refused", () => {
    reportClientError(w.alice, null, report({ message: "y".repeat(5000), stack: "z".repeat(20_000) }), "u".repeat(1000));
    const [group] = groups();
    expect(group!.message.length).toBe(2000);
    expect(group!.stack!.length).toBeLessThanOrEqual(8000);
    expect(group!.userAgent!.length).toBe(300);
  });
});

describe("what a report can hold", () => {
  test("the server redacts whatever the browser sent, in every field", () => {
    reportClientError(
      w.alice,
      null,
      report({
        message: "failed at /join/sekrit?x=1",
        stack: "Error\n    at https://h/feeds/sekrit.ics?y=2",
        context: { path: "/?q=my+private+search", trail: ["/join/sekrit", "/?q=mine"] },
      }),
      null,
    );
    const stored = JSON.stringify(db().query("SELECT * FROM error_groups").all());
    expect(stored).not.toContain("sekrit");
    expect(stored).not.toContain("private");
    expect(stored).not.toContain("q=mine");
  });

  test("unknown fields don't get stored: a page's contents have nowhere to go", () => {
    reportClientError(w.alice, null, report({ page: "My private task", context: { path: "/", tasks: ["My private task"] } }), null);
    expect(JSON.stringify(db().query("SELECT * FROM error_groups").all())).not.toContain("My private task");
  });

  test("a server error's report carries no query string or token", () => {
    reportServerError("route", new Error("bad token pl_0123456789_abcdefghij"), { path: "/join/sekrit?x=1" });
    const [group] = groups();
    expect(group).toMatchObject({ source: "server:route", path: "/join/[redacted]", message: "bad token [redacted]" });
  });
});

describe("signed-out reports", () => {
  test("are their own groups, so one can't reopen or bump a real one", () => {
    const id = reportClientError(w.alice, null, report(), null)!;
    setErrorStatus(w.admin, id, "resolved");
    expect(reportClientError(NOBODY, null, report(), null)).toBeNull();
    expect(groups()).toHaveLength(2);
    expect(groups().find((g) => g.id === id)).toMatchObject({ status: "resolved", count: 1 });
    expect(groups().find((g) => g.id !== id)).toMatchObject({ anonymous: true, who: null });
  });

  test("a flood only ever evicts itself", () => {
    reportClientError(w.alice, null, report({ message: "A real error" }), null);
    const insert = db().query("INSERT INTO error_groups (fingerprint, source, name, message, anonymous, first_at, last_at) VALUES (?, 'client:window', 'E', 'junk', 1, 1, 1)");
    for (let i = 0; i < 300; i++) insert.run(`old-${i}`);
    reportClientError(NOBODY, null, report({ message: "The newest junk" }), null);
    const anonymous = db().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM error_groups WHERE anonymous = 1").get()!.n;
    expect(anonymous).toBe(200);
    expect(db().query("SELECT 1 FROM error_groups WHERE message = 'The newest junk'").get()).toBeTruthy();
    expect(db().query("SELECT 1 FROM error_groups WHERE message = 'A real error'").get()).toBeTruthy();
  });

  test("have a limit, shared unless the deployment names an address", () => {
    const flood = (address: string | null) => {
      for (let i = 0; i < 200; i++) reportClientError(NOBODY, address, report(), null);
    };
    expect(() => flood(null)).toThrow(RateLimitedError);
  });

  test("one address can't spend the whole allowance", () => {
    const flood = () => {
      for (let i = 0; i < 40; i++) reportClientError(NOBODY, "203.0.113.9", report(), null);
    };
    expect(flood).toThrow(RateLimitedError);
    expect(() => reportClientError(NOBODY, "203.0.113.10", report(), null)).not.toThrow();
  });

  test("don't raise the inbox's count, or anyone's phone", () => {
    device(w.admin);
    reportClientError(NOBODY, null, report(), null);
    expect(countOpenErrors()).toBe(0);
    expect(unsent(w.admin.userId)).toHaveLength(0);
  });

  test("a body bigger than a report is refused before it's read", async () => {
    const big = new Request(`${ORIGIN}/api/v1/errors`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify(report({ message: "y".repeat(40_000) })) });
    expect((await apiFromRequest(big)).status).toBe(413);
  });
});

describe("an error loop can't spend someone's writes", () => {
  test("reports have their own bucket", () => {
    expect(() => {
      for (let i = 0; i < 100; i++) reportClientError(w.alice, null, report(), null);
    }).toThrow(RateLimitedError);
    expect(() => createTask(w.alice, { title: "Still works" })).not.toThrow();
  });
});

describe("server errors", () => {
  test("a 4xx isn't one, and neither is someone leaving", () => {
    const request = new Request(`${ORIGIN}/wp-login.php`);
    expect(worthReporting(new ErrorResponse(404, "Not Found", null, true), request)).toBe(false);
    expect(worthReporting(new Error("boom"), request)).toBe(true);
    expect(worthReporting(new ErrorResponse(503, "Down", null), request)).toBe(true);
    const gone = new AbortController();
    gone.abort();
    expect(worthReporting(new Error("boom"), new Request(`${ORIGIN}/`, { signal: gone.signal }))).toBe(false);
  });

  test("reporting never throws, even with the database gone", () => {
    const real = (globalThis as { __punchlistDb__?: unknown }).__punchlistDb__;
    (globalThis as { __punchlistDb__?: unknown }).__punchlistDb__ = undefined;
    try {
      expect(() => reportServerError("route", new Error("boom"))).not.toThrow();
    } finally {
      (globalThis as { __punchlistDb__?: unknown }).__punchlistDb__ = real;
    }
  });

  test("whatever was thrown, it's readable", () => {
    reportServerError("route", "just a string");
    reportServerError("route", new Response(null, { status: 500 }));
    expect(groups().map((g) => g.message).sort()).toEqual(["A 500 response was thrown", "just a string"]);
  });
});

describe("source maps", () => {
  test("a minified frame goes back to its source, and anything else stays as it came", () => {
    const maps = join(dir, "maps");
    mkdirSync(maps);
    // One mapping: generated 1:0 is source line 10, column 4.
    writeFileSync(join(maps, "root-AbCd1234.js.map"), JSON.stringify({ version: 3, sources: ["../../app/root.tsx"], names: [], mappings: "AASI" }));
    const mapped = mapStack("TypeError: x\n    at e (https://h/assets/root-AbCd1234.js:1:1)\n    at f (https://h/assets/gone-AbCd1234.js:1:1)", maps);
    expect(mapped).toContain("at e (app/root.tsx:10:4)");
    expect(mapped).toContain("https://h/assets/gone-AbCd1234.js:1:1");
  });
});

describe("feedback", () => {
  test("comes from people and on-site devices", () => {
    sendFeedback(w.alice, note(), "ua");
    sendFeedback(w.lan, note({ kind: "idea", body: "Add a dark mode" }), "ua");
    expect(listFeedback(w.admin).map((n) => n.who).sort()).toEqual(["Alice Member", "On-site device"]);
  });

  test("not from agents, or the signed out", () => {
    expect(() => sendFeedback(agentFor(w.alice).actor, note(), null)).toThrow(ForbiddenError);
    expect(() => sendFeedback(NOBODY, note(), null)).toThrow(ForbiddenError);
  });

  test("must say something, of a known kind", () => {
    expect(() => sendFeedback(w.alice, note({ body: "   " }), null)).toThrow();
    expect(() => sendFeedback(w.alice, note({ kind: "rant" }), null)).toThrow();
  });

  test("the words stay as typed, while the path around them is redacted", () => {
    sendFeedback(w.alice, note({ body: "It says ?q=this and that", context: { path: "/?q=secret", trail: ["/join/abc"] } }), null);
    const [n] = listFeedback(w.admin);
    expect(n).toMatchObject({ body: "It says ?q=this and that", path: "/" });
    expect(n!.context!.trail).toEqual(["/join/[redacted]"]);
  });

  test("the same id twice is one note", () => {
    const id = uuidv7();
    expect(sendFeedback(w.alice, note({ id }), null).id).toBe(id);
    expect(sendFeedback(w.alice, note({ id }), null).id).toBe(id);
    expect(listFeedback(w.admin)).toHaveLength(1);
  });

  test("someone else's id can't change what they wrote", () => {
    const id = uuidv7();
    sendFeedback(w.alice, note({ id }), null);
    expect(() => sendFeedback(w.bob, note({ id, body: "Mine now" }), null)).toThrow(ConflictError);
    expect(listFeedback(w.admin)[0]!.body).toBe("The button does nothing");
  });

  test("has a limit of its own", () => {
    expect(() => {
      for (let i = 0; i < 20; i++) sendFeedback(w.alice, note(), null);
    }).toThrow(RateLimitedError);
  });
});

describe("the inbox", () => {
  test("is for admins, as themselves: a member can't, and neither can an admin's agent", () => {
    const agent = agentFor(w.admin).actor;
    for (const actor of [w.alice, w.lan, agent, NOBODY]) {
      expect(() => listFeedback(actor)).toThrow(ForbiddenError);
      expect(() => listErrorGroups(actor)).toThrow(ForbiddenError);
    }
    const { id } = sendFeedback(w.alice, note(), null);
    expect(() => setFeedbackStatus(w.alice, id, "done")).toThrow(ForbiddenError);
    expect(() => deleteFeedback(w.alice, id)).toThrow(ForbiddenError);
  });

  test("nothing in it is reachable over the API with a token", async () => {
    const { token } = agentFor(w.admin);
    const response = await apiFromRequest(new Request(`${ORIGIN}/api/v1/feedback/images/whatever`, { headers: { Authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(404);
  });

  test("the count is what's new, and goes down as it's dealt with", () => {
    const { id } = sendFeedback(w.alice, note(), null);
    const error = reportClientError(w.alice, null, report(), null)!;
    expect(countOpenReports()).toBe(2);
    setFeedbackStatus(w.admin, id, "planned");
    setErrorStatus(w.admin, error, "resolved");
    expect(countOpenReports()).toBe(0);
    expect(listFeedback(w.admin, { open: true })).toHaveLength(0);
    expect(listFeedback(w.admin)).toHaveLength(1);
  });

  test("a status has to be a real one, and what's done is in the audit trail", () => {
    const { id } = sendFeedback(w.alice, note(), null);
    expect(() => setFeedbackStatus(w.admin, id, "whatever")).toThrow();
    setFeedbackStatus(w.admin, id, "done");
    expect(auditFor("feedback", id).map((a) => a.action)).toEqual(["status"]);
  });

  test("the audit trail doesn't keep a deleted note's words", () => {
    const { id } = sendFeedback(w.alice, note({ body: "Oops, a private thing" }), null);
    deleteFeedback(w.admin, id);
    expect(listFeedback(w.admin)).toHaveLength(0);
    expect(JSON.stringify(auditFor("feedback", id))).not.toContain("private thing");
  });

  test("a report can't bring a private task with it", () => {
    const { task } = createTask(w.alice, { title: "Quietly job hunting", visibility: "private" });
    sendFeedback(w.alice, note({ context: { path: `/tasks/${task.id}` } }), null);
    reportClientError(w.alice, null, report({ context: { path: `/tasks/${task.id}` } }), null);
    expect(JSON.stringify([listFeedback(w.admin), listErrorGroups(w.admin)])).not.toContain("job hunting");
  });
});

describe("telling admins", () => {
  test("feedback goes to admins with a device who want it, and nobody else", () => {
    device(w.admin);
    device(w.alice);
    sendFeedback(w.bob, note(), null);
    expect(unsent(w.admin.userId)).toHaveLength(1);
    expect(unsent(w.admin.userId)[0]).toMatchObject({ kind: "report", url: "/admin/feedback" });
    expect(unsent(w.alice.userId)).toHaveLength(0);
  });

  test("they can say no", () => {
    device(w.admin);
    setPrefs(w.admin.userId, { reports: false });
    sendFeedback(w.bob, note(), null);
    expect(unsent(w.admin.userId)).toHaveLength(0);
  });

  test("a resent note doesn't buzz again", () => {
    device(w.admin);
    const id = uuidv7();
    sendFeedback(w.bob, note({ id }), null);
    sendFeedback(w.bob, note({ id }), null);
    expect(unsent(w.admin.userId)).toHaveLength(1);
  });

  test("an hour of errors is one message, and repeats of one are none", () => {
    device(w.admin);
    const hour = 3_600_000;
    const start = Math.floor(Date.now() / hour) * hour;
    reportClientError(w.alice, null, report({ message: "First" }), null, start);
    reportClientError(w.alice, null, report({ message: "First" }), null, start + 1);
    reportClientError(w.alice, null, report({ message: "Second" }), null, start + 2);
    expect(unsent(w.admin.userId)).toHaveLength(1);
    reportClientError(w.alice, null, report({ message: "Third" }), null, start + hour);
    expect(unsent(w.admin.userId)).toHaveLength(2);
  });

  test("a server error tells them too", () => {
    device(w.admin);
    reportServerError("route", new Error("boom"));
    expect(unsent(w.admin.userId)[0]!.title).toBe("New error: Error");
  });

  test("a passkey that failed to verify doesn't: anyone can send junk at sign-in", () => {
    device(w.admin);
    reportServerError("webauthn", new Error("Unexpected challenge"), { anonymous: true });
    expect(groups()).toHaveLength(1);
    expect(unsent(w.admin.userId)).toHaveLength(0);
  });
});

describe("screenshots", () => {
  const upload = (body: Uint8Array | string) => new Request(`${ORIGIN}/x`, { method: "POST", body: body as BodyInit });
  const png = async () => new Uint8Array(await sharp({ create: { width: 40, height: 30, channels: 3, background: "#f00" } }).png().toBuffer());

  test("only ever the re-encoded copy reaches the disk: GPS doesn't", async () => {
    const photo = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#0f0" } })
      .withExif({ IFD3: { GPSLatitude: "37/1 46/1 0/1" }, IFD0: { Copyright: "SECRET-EXIF" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeTruthy();

    const { id } = sendFeedback(w.alice, note(), null);
    const image = await addFeedbackImage(w.alice, id, upload(new Uint8Array(photo)));

    const files = readdirSync(join(dir, "feedback"));
    expect(files).toEqual([image.id]);
    const stored = await Bun.file(join(dir, "feedback", image.id)).bytes();
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(Buffer.from(stored).includes("SECRET-EXIF")).toBe(false);
  });

  test("only for the note's own author, while it's fresh", async () => {
    const { id } = sendFeedback(w.alice, note(), null, 1000);
    await expect(addFeedbackImage(w.bob, id, upload(await png()), 1001)).rejects.toThrow(NotFoundError);
    await expect(addFeedbackImage(w.alice, id, upload(await png()), 1000 + 11 * 60_000)).rejects.toThrow(ConflictError);
  });

  test("not from on-site devices, who can't attach anything", async () => {
    const { id } = sendFeedback(w.lan, note(), null);
    await expect(addFeedbackImage(w.lan, id, upload(await png()))).rejects.toThrow(ForbiddenError);
  });

  test("an image is what it is, not what it claims: SVG and text are refused", async () => {
    const { id } = sendFeedback(w.alice, note(), null);
    await expect(addFeedbackImage(w.alice, id, upload("<svg onload=alert(1)></svg>"))).rejects.toThrow(UserInputError);
    await expect(addFeedbackImage(w.alice, id, upload(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0])))).rejects.toThrow(UserInputError);
  });

  test("three to a note", async () => {
    const { id } = sendFeedback(w.alice, note(), null);
    for (let i = 0; i < 3; i++) await addFeedbackImage(w.alice, id, upload(await png()));
    await expect(addFeedbackImage(w.alice, id, upload(await png()))).rejects.toThrow(UserInputError);
  });

  test("admins can read them, and nobody else can tell they exist", async () => {
    const { id } = sendFeedback(w.alice, note(), null);
    const image = await addFeedbackImage(w.alice, id, upload(await png()));
    const response = serveFeedbackImage(w.admin, image.id);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(() => serveFeedbackImage(w.alice, image.id)).toThrow(NotFoundError);
    expect(() => serveFeedbackImage(agentFor(w.admin).actor, image.id)).toThrow(NotFoundError);
    expect(listFeedback(w.admin)[0]!.images).toEqual([image.id]);
  });

  test("deleting a note deletes its bytes", async () => {
    const { id } = sendFeedback(w.alice, note(), null);
    const image = await addFeedbackImage(w.alice, id, upload(await png()));
    deleteFeedback(w.admin, id);
    expect(existsSync(join(dir, "feedback", image.id))).toBe(false);
  });

  test("the whole way through, from a cookie", async () => {
    const cookie = await sessionHeader(w.alice);
    const created = await apiFromRequest(new Request(`${ORIGIN}/api/v1/feedback`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie }, body: JSON.stringify(note()) }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const added = await apiFromRequest(new Request(`${ORIGIN}/api/v1/feedback/${id}/images`, { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie }, body: await png() }));
    expect(added.status).toBe(201);
  });
});
