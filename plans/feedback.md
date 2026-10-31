# In-app feedback and error reporting

Generic design notes. Nothing about any one deployment belongs here.

## Goal

Two things reach the people who run a space without anyone having to ask:

1. **Every error**, from the browser and the server, automatically.
2. **What people want to say**: something's broken, something's confusing, an idea,
   something that looks wrong. From inside the app, with where they were attached.

## Environment

- Run the e2e suite through `srmctl run --slots 3 --low`; it builds and starts servers.

## Decisions

- **Errors are grouped, not logged.** One row per fingerprint, with a count, first and
  last seen, and the latest sample. A render loop costs one row. A resolved group that
  happens again reopens by itself.
- **The fingerprint survives a release.** Name, message with ids and numbers collapsed,
  and the top three frames' files with no line numbers or content hashes.
- **Production stacks are mapped at ingest.** Browser code is minified, so a raw stack is
  useless. `hidden` source maps are moved to `build/sourcemaps/` by `finalize-build`, where
  they aren't served, and the server reads them when a report arrives. It has to be at
  ingest: the maps for an old build go away with its image, and the fingerprint needs the
  real file names.
- **`nobody` may report an error, and nothing else.** Sign-in is where a phone's passkey
  failure happens, and that person has no session. So `POST /api/v1/errors` is the one API
  route a signed-out visitor reaches. It still needs same-origin JSON. What keeps it safe:
  - its own rate limit, per address when the deployment names one, otherwise shared
  - a small body limit and a cap on every field
  - signed-out reports are a separate group from signed-in ones, even with identical
    text, so they can't reopen a resolved group or bump a real one
  - at most 200 rows, oldest evicted, so a flood can only ever push out its own kind
  - labelled "signed out" in the inbox, and never sent as a notification
- **Feedback needs an identity:** a person or an on-site device. Free text from the open
  internet, with a push to admins behind it, is a spam channel. Agents and integrations
  have no reason to send it. The error page says so if a signed-out person tries.
- **Screenshots are for signed-in people,** matching the rule that on-site visitors can't
  attach. They're re-encoded on arrival, so EXIF and GPS never touch the disk, and the
  original bytes aren't kept. Only admins can read them.
- **Reports never carry the page.** Admins don't get private tasks, and this must not be
  a side door. A report holds a path, never page content, request bodies or headers, and
  the note says who reads it. Query strings go (`?q=` is what someone searched for).
  Capability paths (`/join/`, `/feeds/`) and anything token-shaped are redacted, in the
  browser and again on the server, which is the one that counts.
- **What counts as an error.** A deliberate refusal (401, 403, 404, 409, 429) is the app
  working. So is being offline. Everything else counts: uncaught exceptions, rejections,
  React and router failures, a 5xx the proxy answered, a 400 or 415 the UI should never
  have caused, and on the server anything `handleError` sees apart from 4xx, plus the
  background loops. A 500 from the app is reported by the server, not by the browser too.
- **Reporting can't hurt anything.** It never throws, never toasts, and never reports
  its own failures. It has its own rate limit bucket, so an error loop can't spend the
  person's write allowance. In the browser: identical errors once a minute, at most 25 a
  page load.
- **Offline:** errors and notes wait in an outbox on the device, follow the same rule as
  the check-off queue (dropped rather than sent as someone else), and go on reconnecting.
  A note has a client-made id, so a retry doesn't double it. A screenshot doesn't queue:
  with one attached, the dialog stays open and says why.
- **The inbox is `/admin/feedback`,** admin only, with a count in the nav. Admins get a
  push for feedback and for new or returning signed-in errors, at most one error push an
  hour, with a toggle in notification settings.
- **Agents don't get the inbox.** "Admin actions aren't available to agents at all", and
  these reports are text that anyone, even signed out, can write: feeding them to an
  agent is a prompt-injection path.

## Steps

- [x] Schema, redaction, limits, permissions
- [x] Server: `src/error-reports.ts`, `src/feedback.ts`, source maps, routes
- [x] Server hooks: `handleError`, render errors, process events, background loops
- [x] Browser: `entry.client.tsx`, reporter, outbox, service worker
- [x] UI: the dialog, the error page's note, the inbox, nav badge, settings toggle
- [x] Notifications
- [x] Tests, README, design notes
- [x] Full e2e suite, then merge to `master`
- [x] Deployed
- [ ] First use of the dialog and inbox on a real iPhone

## Findings

- **Losing the connection on any page but the home list destroys an open dialog.** A live
  refresh fails, the root error page replaces the app, and whatever was typed goes with
  it. So the dialog keeps its draft on the device, with the pages' own copies, which are
  cleared when the person changes.
- **Offline copies are written by a page's first refresh, not its load.** For the moment
  between, even the home list shows "You're offline" if the connection drops, and an open
  dialog goes with it. That predates this work and the draft covers it. Tests that go
  offline wait for `offlineCopiesKept`.
- **`handleError` gets every scanner's 404,** because the router raises those as errors
  itself. Defining it also replaces the default logging. `worthReporting` filters; the
  hook logs for itself.
- **The MCP SDK turns a thrown tool error into a result,** so it never reaches
  `handleError`. `tool()` in `src/mcp.ts` reports before rethrowing.
- **`isOfflineError` treated every `TypeError` as offline,** so a plain bug in a page said
  "You're offline". It reads the text now, as the reporter does.
- Vite's `isSsrBuild` is undefined under the React Router build, so the server gets a map
  too. It's harmless, and only the browser's are moved.

- **A note could beat the report of the error before it,** and arrive naming nothing. Sending
  a note now waits up to 2 seconds for reports on their way.

## Verified

- **A real server failure, by hand.** A production build with a table renamed out from
  under it: three failing requests, a page and two others, made one `server:route` group
  with a count of 3, the actor and the version. A scanner's 404 added nothing, and a
  `?q=` on a failing request wasn't stored. This isn't in the suite, since the suite's
  servers share their databases between tests.
- **The service worker's reports are accepted,** `Origin` included: `e2e/feedback.spec.ts`.
- **The notifier loop is off in e2e,** so a report's push is covered by a unit test
  through the real send pass, with a fake sender. A push to a real phone hasn't been seen.
- **A machine on the site's own network is on site.** Smoke-testing a deployment from one
  isn't testing as a signed-out visitor, and `POST /api/v1/feedback` is accepted. Use an
  internet path, or only read.

## Not to do

- Don't capture page text, form values, or a screenshot the person didn't choose.
- Don't hook `console.error` in the browser: its arguments are whatever anyone logged.
- Don't call the reporter from inside itself.
