import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  // Signed-out pages.
  route("signin", "routes/signin.tsx"),
  route("signout", "routes/signout.ts"),
  route("join/:token", "routes/join.$token.ts"),
  route("join", "routes/join.tsx"),

  // Everything that shows tasks shares the app chrome.
  layout("routes/_app.tsx", [
    index("routes/_app._index.tsx"),
    route("tasks/new", "routes/_app.tasks.new.tsx"),
    route("tasks/:id", "routes/_app.tasks.$id.tsx"),
    route("map", "routes/_app.map.tsx"),
    route("activity", "routes/_app.activity.tsx"),
    ...prefix("settings", [
      index("routes/_app.settings._index.tsx"),
      route("notifications", "routes/_app.settings.notifications.tsx"),
      route("calendar", "routes/_app.settings.calendar.tsx"),
      route("agents", "routes/_app.settings.agents.tsx"),
    ]),
    ...prefix("admin", [
      route("people", "routes/_app.admin.people.tsx"),
      route("people/:userId", "routes/_app.admin.people.$userId.tsx"),
      route("labels", "routes/_app.admin.labels.tsx"),
      route("audit", "routes/_app.admin.audit.tsx"),
      route("feedback", "routes/_app.admin.feedback.tsx"),
    ]),
  ]),

  // Browsers ask for this whether or not the page names an icon.
  route("favicon.ico", "routes/favicon.ts"),
  route("healthz", "routes/healthz.ts"),
  route("logo.svg", "routes/logo.ts"),
  // The skill an agent installs. Deployment-neutral, so public.
  route("skill/SKILL.md", "routes/skill.ts"),

  // The REST API. The UI uses it too.
  route("api/v1/*", "routes/api.v1.ts"),

  // Repairs an installed copy with a stuck service worker.
  route("api/r", "routes/api.r.ts"),

  // Agents.
  route("mcp", "routes/mcp.ts"),

  // Calendar clients can't sign in; the path is the capability.
  route("feeds/:file", "routes/feeds.ts"),

  // No extension in these URLs, so nothing in front can cache them by type.
  route("attachments/:id", "routes/attachments.ts"),
  route("attachments/:id/thumb", "routes/attachments.thumb.ts"),

  // JSON endpoints for the passkey ceremonies.
  ...prefix("api/passkey", [
    route("register-options", "routes/api.passkey.register-options.ts"),
    route("register-verify", "routes/api.passkey.register-verify.ts"),
    route("signin-options", "routes/api.passkey.signin-options.ts"),
    route("signin-verify", "routes/api.passkey.signin-verify.ts"),
  ]),

  // Generated rather than a static file: its name and colour come from the
  // deployment's config, so the same image can be branded per install.
  route("manifest.webmanifest", "routes/manifest.ts"),
] satisfies RouteConfig;
