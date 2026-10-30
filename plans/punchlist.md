# Punchlist: design notes

A task list that belongs to a physical place rather than to a person's phone. Anyone
in the space can see what needs doing and tick it off; people who sign in can do so from
anywhere and keep private items; agents read and write under their own identity. The
README describes the app. These notes hold what isn't obvious from the code.

The app is generic. A deployment's name, map, zones and integrations come from its own
`CONFIG_FILE`, and nothing about any one deployment belongs in this repository.

## Next

- [ ] First real image from CI, which is the first `docker build`
- [ ] A real iPhone: passkey, install, push (Chromium only so far)
- [ ] Sign-in over OAuth for MCP clients that can't send a static token
- [ ] Kiosk mode, and a "proposed" state for agent-created tasks

## Found while building

- **`@react-router/express` appends response headers, it doesn't set them.** A
  `Cache-Control` default preset in Express came out as
  `private, no-store, private, no-store`, and a route's own `public, max-age=300`
  would have become contradictory rather than replacing it. `X-Content-Type-Options`
  doubled the same way. Defaults now live in React Router middleware, applied only
  when a route set nothing (`defaultHeadersMiddleware`, `app/auth.server.ts`). Static
  files set theirs in `express.static`'s `setHeaders`.
- **A live refresh revalidates every loader, and any form that re-seeds from loader
  data then loses what's been typed.** The notification page did: a new object with
  the same contents wiped an unsaved toggle. Compare by value. `TaskForm` is seeded
  once, so it's unaffected. The next form to be written needs the same care.
- **Refreshing on `EventSource` open was needed, and exposed two more races.** The gap
  between page load and the stream connecting lost updates (a flaky e2e, one failure
  in three runs). Fixing it made a refresh land during sign-out: the session died
  mid-load, sending the page to `/signin?next=/settings.data?_routes=...`, and an
  in-flight loader wrote its offline copy back after sign-out cleared them. Sign-out
  is now POST, clear, full page load, with writes shut off first, and the `next` path
  drops `.data` and `_routes`.
- **`request.url` in a loader is the `.data` URL on a client navigation.** Anything
  building a return path from it has to normalise it.
- **Unix sockets can't be tested on Windows.** Three socket unit tests are skipped
  there. They were run on Linux under WSL, along with the real server on a socket:
  mode `srw-rw-rw-`, `/healthz`, the Dockerfile's HEALTHCHECK command, LAN header
  accepted, a second server refused while the first is live, stale file after
  `SIGKILL` cleared on restart, file removed on `SIGTERM`.
- **`bun run start` as PID 1 doesn't pass `SIGTERM` to the server,** so the socket
  wasn't cleaned up (harmless, the next start clears it). The Dockerfile's `CMD` is
  `bun server.ts` directly.
- **Nothing depends on `req.ip` or `trust proxy`.** `trust proxy` is off. Rate limits
  are keyed by actor; anonymous devices also share a ceiling, since a device id is
  only a cookie. Passkey ceremonies have no actor, so they share one generous bucket,
  and the in-memory ceremony store is capped at 10,000 so a flood can't grow it. That
  bucket could be exhausted deliberately to slow sign-in for everyone; it's a
  limit worth raising only if that ever happens.
- `Headers` normalises `"lan "` to `"lan"`, as HTTP allows, so trailing whitespace
  on the perimeter value counts as `lan`. `lan, lan` (a header sent twice) doesn't.
- Mantine 9's `Select` and `MultiSelect` inputs are `role="combobox"`. Their listbox
  shares the label, so `getByLabel` is ambiguous in tests; use the role.
- `rrule`'s `after()` walks to year 9999 on an impossible rule such as February 30.
  `between` with an iterator stops at the first hit, so that's what's used, with a
  ten-year horizon.
- WSL here has no Bun, no Docker and no route to GitHub. Docker isn't installed on
  Windows either, so **`docker build` has not been run**. Linux dependencies can be
  fetched from Windows with `bun install --os=linux --cpu=x64`, but the build has to
  run with the host's own native packages.

## Choices worth knowing

Behaviour that was a judgement call.

- **`via` on an integration comes from config** (`via: ha`, say),
  defaulting to `api`, so no integration has its own code.
- **Anyone signed in may edit and delete a public task.** Taking a public task
  private is narrower: its owner, its creator, or an admin, since it disappears for
  everyone else. A private task's sharing, assignees and turning public are the
  owner's alone, because assigning grants sight. Deleting is soft; the row and history
  stay. An on-site device may edit tasks it made itself.
- **On-site visitors can't comment, attach, assign, or set a repeat.** Their tier
  covers viewing, checking off and adding.
- **Dedupe keys belong to the actor that made them,** not to the owner: one agent
  can't reach into another's private tasks through a shared key. The cost is that a
  rotated agent token starts a new key space.
- **A schedule that has fallen behind skips to its next date ahead.** Finishing
  January's in May gives June, not a February already gone. Finishing early gives the
  date after the one it was due.
- **A check-off's next occurrence is made in the same transaction,** so it's visible
  at once with its future date. The list files anything more than 14 days out under
  Later. Reopening takes that occurrence back, unless someone has changed it, in which
  case reopening is refused.
- **A feed scoped "all public tasks" can't include private ones.** Private needs
  "public plus mine" or labels. With private off, "public plus mine" equals all public.
- **Agents need `tasks:read` to touch an existing task,** including to check it off.
- **Quiet hours hold notifications; a pause drops them.** Held ones go when the window
  ends, or are dropped after 24 hours.
- **`/api/v1` is the UI's API as well as the agents'.** The browser has no private
  route. Cookie and on-site calls need the same-origin `Origin` and JSON; bearer calls
  don't, since a token isn't ambient.
- **Offline covers the home list only.** Other pages need a connection. Task pages
  fail with a plain "you're offline".
- REST uses `dedupeKey` (camelCase like the rest of its JSON); MCP uses `dedupe_key`.
