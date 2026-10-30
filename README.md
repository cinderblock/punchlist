# Punchlist

A shared list of physical jobs for a real place: a workshop, a lab, a clubhouse.
It belongs to the space rather than to anyone's phone. Anyone on site can see what
needs doing and tick it off. People who sign in can do that from anywhere, keep
private items, and get reminders. Agents can read and write tasks under their own
names.

It is deliberately **generic**: no organisation's name, hostname, map or person
appears in this repository. All of that is one YAML file belonging to whoever runs
it.

## What it does

- **Phone-first.** A fast list with one-tap check-off, big targets, and an undo.
  Installable as an app. Check-offs made with no signal stick, wait on the device,
  and go when the connection comes back.

- **Passkey-only sign-in.** No passwords and no email. The first admin comes from a
  one-time link at first boot. Everyone else gets an invite link or QR code, good
  for 24 hours. A new device syncs a passkey or uses an add-a-device link; someone
  who has lost everything gets a recovery link from an admin; a locked-out last
  admin uses the CLI on the host, which is the root of trust.

- **An anonymous tier for people on site, if you want one.** Your reverse proxy
  says which requests are physically on site. Those visitors can view, check off
  and add public tasks, with no account. Editing others' tasks and deleting need a
  sign-in. Unset, there's no anonymous tier at all.

- **Public and private tasks.** Public means everyone in the space, and nobody on
  the internet. Private means the owner, plus anyone it's shared with or assigned
  to. Admins don't get private tasks in the UI or API. They could read the database,
  and the app says so rather than claiming otherwise.

- **Locations.** Draw your floor plan in the config file, in your own units. Tapping
  the map gives a point, and the app works out the zone from it. Zones are what you
  filter by; points are what you walk to. A space with no map uses named zones as a
  flat list.

- **Repeating tasks, two kinds.** A *schedule* is an RRULE ("the first Monday"), and
  its next date doesn't depend on when it was done. *After completion* is an interval
  ("30 days after last done"). Only one occurrence is ever open, so a missed filter
  change doesn't pile up.

- **Everything is an event.** Every change records who, on whose behalf, through
  what, and what changed, in an append-only table the database itself protects.

- **Attachments.** Photos and files on a task, up to 25 MB each. Every read goes
  through the app and inherits the task's visibility. Thumbnails are re-encoded,
  dropping EXIF.

- **Live updates.** A wall tablet refreshes itself over server-sent events.

- **Calendar feeds.** Subscribe from Google or Apple Calendar: tasks with a due date
  appear as all-day events. Each feed is a revocable capability URL, with private
  tasks off unless you ask, and titles-only if you like.

- **Notifications.** Web Push for tasks assigned to you, tasks coming due, a daily
  overdue digest, new tasks in a label or zone you watch, and comments on your tasks,
  with quiet hours. iPhones can only do this in the installed app, so the app walks
  people through Add to Home Screen instead of offering a button that fails.
  Payloads are Declarative Web Push (iOS 18.4+), with a service worker for the rest.

- **Agents.** A named token owned by one person, with scopes. Its rights are its
  scopes intersected with its owner's current rights, and it shows up as "Claude
  Code, for Sam" everywhere. There's a REST API and an MCP server, and `/settings/agents`
  gives the one command to set one up, skill included. Agents can't delete anything.

- **Integrations.** A service declared in the config file, with its own token and
  name, for monitoring and the like. `dedupeKey` means "the sensor is still dead"
  updates the open task rather than adding another, and closing by key handles the
  recovery.

## Stack

[Bun](https://bun.sh), React Router 8, Mantine 9, raw SQL on `bun:sqlite`,
`@simplewebauthn`, `web-push`, `zod`, the MCP TypeScript SDK, and `bun test` plus
Playwright.

## Running locally

Needs Bun 1.4.2 or later. Works on Windows, macOS and Linux.

```sh
bun install
cp .env.example .env     # the defaults run on http://localhost:3000
bun run dev
```

Passkeys work on `http://localhost`, and on https anywhere else.

```sh
bun run typecheck
bun run test             # unit and integration tests
bun run test:e2e         # builds, then drives real Chromium with a virtual authenticator
bun run build && bun run start
```

## First run

With no admin yet, the server prints a one-time link to its log on every start.
Open it, enter a name, and make a passkey. If you missed it:

```sh
bun run admin-link
docker exec punchlist bun run admin-link
```

With an admin already there, the same command prints a one-time link for a new
admin. That's the way back in if every admin has lost their passkeys.

## Running it for your own space

CI publishes the image to `ghcr.io/<owner>/punchlist`. It runs with no config
file at all, so you can try it in one command:

```sh
docker run --rm -p 3000:3000 \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  -v punchlist-data:/data \
  ghcr.io/<owner>/punchlist
```

For real, you need three things:

1. **An https origin, chosen for good.** `PUBLIC_BASE_URL` must be the exact origin
   browsers use. It's the passkey Relying Party ID, so changing it later orphans
   every passkey. Use a hostname of its own: a parent domain would let every other
   app under it ask for these credentials.

2. **A volume at `/data`.** It holds the SQLite database (in WAL mode) and the
   attachments. Back up both.

3. **A config file** at `/config/punchlist.yaml`, mounted read-only. Start from
   [`examples/punchlist.yaml`](examples/punchlist.yaml). Mount the file, not a
   directory that holds your secrets.

Generate `VAPID_PRIVATE_KEY` once and keep it. A new key silently orphans every
device that turned notifications on.

### Behind a reverse proxy

The app does not look at client addresses or `X-Forwarded-*` at all. It works out
who someone is from a session cookie, a bearer token, or the perimeter header below,
and compares `Origin` with `PUBLIC_BASE_URL`. Rate limits are keyed by actor. So a
unix socket, where a request has no peer address, works exactly like a port.

Set `SOCKET_PATH` to listen on a unix socket instead of `PORT`. The socket is made
connectable by other users, since the proxy usually runs as someone else, so put it
in a directory only the proxy shares. A stale socket file is removed on start, but
only if nothing is listening on it.

Live updates need the proxy to flush as it goes: `flush_interval -1` in Caddy, for
instance.

### The on-site tier

`TRUSTED_PERIMETER_HEADER` names a header your proxy sets to exactly `lan` for
requests that are physically on site. Unset means no anonymous tier, and the header
is ignored, so a default install fails closed.

The app can't check any of this for you, and if it's wrong, anyone can read your
public tasks. It's only sound when:

- **Nothing but the proxy can reach the app.** Use the unix socket. On a TCP port,
  anything that can connect can set the header.
- **The proxy deletes the header on the outside path and overwrites it on the inside
  path**, so a client can never supply it.
- **"On site" is judged by the network, not by a private address.** VPN peers have
  private addresses and aren't on site. Match the local link.
- **A CDN in front is ruled out first.** A request through a CDN must go down the
  outside path even if its address looks local. Send anything carrying the CDN's own
  header there before any other check.

Being on site only ever grants the anonymous tier. It never reveals a private task,
never grants agent or admin rights, and never authorises enrolment. Mutations from
it need a same-origin `Origin` and a JSON body, because a malicious page in a LAN
browser would otherwise inherit that network position.

A phone using iCloud Private Relay or encrypted DNS may arrive through the CDN and
be treated as outside. That's the safe failure, and the sign-in page says what to do.

### Agents

Under Settings, then Agents, create an agent and pick what it may do. The page
gives the setup command for that token, for Claude Code:

```sh
claude mcp add --transport http punchlist https://your.host/mcp --header "Authorization: Bearer pl_..."
```

| Scope | Allows |
| --- | --- |
| `tasks:read` | See public tasks. Needed for anything on an existing task |
| `tasks:write` | Add and edit tasks, and comment |
| `tasks:complete` | Check off and reopen |
| `private:read` | See its owner's private tasks |
| `private:write` | Change them |
| `attachments:write` | Attach files |

The skill in [`skills/punchlist/SKILL.md`](skills/punchlist/SKILL.md) tells an agent
how to behave here. The server also serves it at `/skill/SKILL.md`.

## Configuration

### Environment

| Variable | Default | |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | required | The exact origin. Must be bare: no path, no trailing slash |
| `SESSION_SECRET` | required | Signs cookies. `openssl rand -base64 48` |
| `PORT` | `3000` | |
| `SOCKET_PATH` | | Listen on this unix socket instead of `PORT` |
| `TRUSTED_PERIMETER_HEADER` | | The on-site header's name. Unset is no anonymous tier |
| `CONFIG_FILE` | `/config/punchlist.yaml` | Missing means defaults and no map |
| `DATABASE_PATH` | `./data/punchlist.db` | `/data/punchlist.db` in the image |
| `ATTACHMENTS_DIR` | `attachments` beside the database | |
| `VAPID_PRIVATE_KEY` | | Turns on Web Push. Keep it forever |
| `VAPID_SUBJECT` | `PUBLIC_BASE_URL`, when https | A `mailto:` or `https:` contact |
| `NOTIFY_EVERY_SECONDS` | `60` | How often reminders are checked. `0` turns them off |

The container log prints the resolved settings at startup, secrets aside.

### The config file

One YAML file, validated at boot against
[`src/config-schema.ts`](src/config-schema.ts). A bad file, including a misspelled
key, refuses to start and says where. Every key is optional. Secrets don't go here.

| Key | Default | |
| --- | --- | --- |
| `name` | `Punchlist` | |
| `shortName` | `Punchlist` | Under the home-screen icon, 12 characters at most |
| `themeColor` | `#2f9e44` | |
| `logoSvg` | | An inline SVG document, served as an image so scripts in it don't run |
| `timezone` | `TZ`, else UTC | Every date and time in the app, shown and judged |
| `onSiteLabel` | `On-site device` | What an anonymous on-site browser is called |
| `zones` | `[]` | `{ id, name }`. Named zones with no map behind them |
| `labels` | `[]` | `{ name, color? }`. Seeded once; admins edit them in the app after that |
| `maps` | `[]` | See below |
| `integrations` | `[]` | See below |

A map:

| Key | |
| --- | --- |
| `id`, `name` | |
| `units` | Shown beside coordinates. Default `m`. Nothing is converted |
| `outline` | The building as `[x, y]` points. Its bounding box is the map's extent |
| `yAxis` | `up` (default) for surveyed coordinates, `down` for image-like ones |
| `zones` | `{ id, name, polygon, color? }`. Zone ids are unique across the whole file |
| `places` | `{ id, name, x, y }`. Named spots, offered as shortcuts when picking a location |

An integration:

| Key | |
| --- | --- |
| `id` | Part of its identity in the audit trail |
| `name` | Who the app says did it, everywhere |
| `tokenEnv` | The *name* of the environment variable holding its bearer token, 32 characters or more. Unset, the integration stays off and the log says so |
| `scopes` | Any of `tasks:read`, `tasks:write`, `tasks:complete`. All three by default |
| `via` | What the audit trail records as the channel. Default `api` |

An integration has no owner, so it never sees a private task. It can edit only the
tasks it made, and can't assign or delete.

## The API

Everything the UI does goes through this, and through one module behind it
(`src/tasks.ts`), so audit and permissions live in exactly one place. Send
`Authorization: Bearer <token>`. Send `Idempotency-Key` on any write you might retry.

| | |
| --- | --- |
| `GET /api/v1/me` | Who this token is |
| `GET /api/v1/tasks` | `status`, `q`, `label`, `zone`, `assignee`, `unassigned`, `visibility`, `dueBy`, `limit` |
| `POST /api/v1/tasks` | `title`, and optionally `details`, `visibility`, `dueDate`, `labels`, `assignees`, `sharedWith`, `location`, `recurrence`, `dedupeKey` |
| `GET`, `PATCH`, `DELETE /api/v1/tasks/:id` | `expectedRev` on a `PATCH` refuses a stale edit |
| `POST /api/v1/tasks/:id/complete` | `note`, `at` |
| `POST /api/v1/tasks/:id/reopen` | |
| `POST /api/v1/dedupe/:key/complete` | Close the open task with this key, if there is one |
| `GET /api/v1/tasks/:id/events`, `/comments` | `POST` to `/comments` adds one |
| `GET`, `POST /api/v1/tasks/:id/attachments` | The `POST` body is the file; `?filename=` names it |
| `GET /api/v1/labels`, `/zones`, `/maps`, `/people`, `/activity` | |
| `GET /api/v1/events` | Server-sent events |

`POST /mcp` is the same again over MCP (stateless Streamable HTTP): `list_tasks`,
`search_tasks`, `get_task`, `create_task`, `update_task`, `complete_task`,
`reopen_task`, `add_comment`, `list_labels`, `list_zones`, `list_people`, `who_am_i`.

## Layout

```
app/               React Router: pages, resource routes, the browser's side
  tasks.server.ts  what task pages load, always through src/tasks.ts
  offline/         the check-off queue and last-read copies
  pwa/             service worker registration, push, install detection
src/
  tasks.ts         the domain layer: every read and write of a task
  permissions.ts   the whole permission model, as pure functions
  actors.ts        who can be doing something
  http/            REST, SSE, turning a request into an actor
  mcp.ts           the MCP server, thin calls into tasks.ts
  recurrence.ts    the two kinds of repeating
  feeds.ts, ics.ts calendar feeds
  attachment-store.ts  bytes on disk, and the headers that make them safe
  notifications/   Web Push: what to send, to whom, and when
  config-schema.ts the deployment file's schema
skills/            the skill agents install
examples/          an example deployment file
e2e/               Playwright tests
```

## License

MIT
