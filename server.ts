import { basename } from "node:path";

import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import morgan from "morgan";
import type { ServerBuild } from "react-router";

import { config } from "./src/config.server.ts";
import { openSocket, prepareSocket, removeSocket } from "./src/socket.ts";

/**
 * The production server: Express serving the React Router build.
 *
 * It sits behind a reverse proxy that terminates TLS, possibly over a unix
 * socket. So what this process sees of the connection means nothing:
 *
 *   - There may be no peer address at all, so `req.ip` is undefined and "trust
 *     proxy" has nothing to work from. It's off, and nothing security-relevant
 *     reads either: identity comes from src/http/resolve-actor.ts, which reads
 *     no address, and rate limits are keyed by actor.
 *   - The scheme looks like http, so `request.url`'s origin can't be believed.
 *     Same-origin checks compare the Origin header against PUBLIC_BASE_URL, and
 *     React Router is told that's an allowed origin. Without this it refuses
 *     every form behind a TLS-terminating proxy with a bare 400.
 */

// The build only exists after `bun run build`. The specifier is a variable so
// that typechecking a clean checkout doesn't go looking for the file.
const BUILD = "./build/server/index.js";
const build = (await import(BUILD)) as ServerBuild;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  next();
});

app.use(
  compression({
    // Event streams and files aren't worth holding back: a compressor buffers
    // until it has enough to send, and a stream must go out as it's written.
    filter: (req, res) => {
      if (req.path === "/api/v1/events" || req.path.startsWith("/api/v1/attachments/")) return false;
      if (req.path.startsWith("/attachments/")) return false;
      return compression.filter(req, res);
    },
  }),
);

// Hashed build assets are immutable; everything else in build/client (the
// service worker, icons) may change between builds.
app.use("/assets", express.static("build/client/assets", { immutable: true, maxAge: "1y" }));
app.use(
  express.static("build/client", {
    maxAge: "1h",
    setHeaders(res, filePath) {
      // The worker script decides when every other cached file is replaced, so
      // it must never be answered from a cache.
      if (basename(filePath) === "sw.js") res.setHeader("Cache-Control", "no-cache");
    },
  }),
);

// Paths carry capabilities (/feeds/<token>.ics, /join/<token>), and logs outlive them.
morgan.token("safe-url", (req) => {
  const url = (req as express.Request).originalUrl ?? "";
  return url.replace(/^\/feeds\/[^/?]+/, "/feeds/[redacted]").replace(/^\/join\/[^/?]+/, "/join/[redacted]");
});
app.use(morgan(":method :safe-url :status :res[content-length] - :response-time ms"));

// Everything past here is the app, and anything it doesn't say otherwise about
// is treated as private. A route that wants caching sets its own header, which
// replaces this one. Task data must never sit in a shared cache, and a
// Cloudflare-proxied name caches by extension.
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

const publicHost = new URL(config.publicBaseUrl).host;
app.use(createRequestHandler({ build: { ...build, allowedActionOrigins: [publicHost] } }));

const onError = (err: unknown) => {
  if (!err) return;
  console.error("[server] couldn't start listening:", err);
  process.exit(1);
};

if (config.socketPath) {
  const path = config.socketPath;
  await prepareSocket(path);
  const server = app.listen(path, (err?: Error) => {
    onError(err);
    openSocket(path);
    console.log(`[server] listening on unix:${path}, serving ${config.publicBaseUrl}`);
  });
  server.on("error", onError);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      removeSocket(path);
      process.exit(0);
    });
  }
} else {
  app.listen(config.port, (err?: Error) => {
    onError(err);
    console.log(`[server] listening on http://localhost:${config.port}, serving ${config.publicBaseUrl}`);
  });
}
