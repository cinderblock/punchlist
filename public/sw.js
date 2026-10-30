/* Punchlist service worker.
 *
 * Makes the installed app start with no connection, and receives Web Push.
 *
 *   build assets     cached at install, served cache-first. Their names are
 *                    content-hashed, so a cached copy is never wrong.
 *   the home page    network-first; a fresh copy is kept and served when the
 *                    network or the app is down. Its data is the last-read list.
 *   icons, manifest  served from cache, refreshed in the background.
 *   everything else  never touched. /api/, .data, /attachments/, /feeds/ and
 *                    /mcp must only ever come from the server, after its checks.
 *
 * `bun run build` replaces the placeholder below with this build's id and file
 * list (scripts/finalize-build.ts), which is also what makes each release a new
 * worker. The previous release's files are kept until the next, so a page still
 * running old code can finish loading.
 *
 * Signing out deletes the kept page (app/offline/copies.ts): on a shared device
 * the next person mustn't find someone else's list in it.
 */

const PRECACHE = self.__PL_PRECACHE__;
const BUILD = (PRECACHE && PRECACHE.buildId) || "dev";
const ASSETS = `pl-assets-${BUILD}`;
const PAGES = "pl-pages";
const STATIC = "pl-static";
const META = "pl-meta";
const NAVIGATION_TIMEOUT_MS = 6000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (PRECACHE && PRECACHE.urls.length) {
        const cache = await caches.open(ASSETS);
        await cache.addAll(PRECACHE.urls);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Keep this build's assets and the previous build's; drop older ones.
      const meta = await caches.open(META);
      const previous = await meta.match("/current-build").then((r) => (r ? r.text() : null));
      const keep = new Set([ASSETS, previous && previous !== BUILD ? `pl-assets-${previous}` : null]);
      for (const name of await caches.keys()) {
        if (name.startsWith("pl-assets-") && !keep.has(name)) await caches.delete(name);
      }
      await meta.put("/current-build", new Response(BUILD));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (request.mode === "navigate") {
    if (path === "/") event.respondWith(navigate(event));
  } else if (path.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else if (path.startsWith("/icons/") || path === "/manifest.webmanifest" || path === "/favicon.ico") {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});

async function keepPage(response) {
  const html = (response.headers.get("content-type") || "").includes("text/html");
  // Never keep a redirect (to sign-in, say) or an error in place of the page.
  if (!response.ok || response.redirected || response.type !== "basic" || !html) return;
  const cache = await caches.open(PAGES);
  await cache.put("/", response);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function navigate(event) {
  try {
    const response = await withTimeout(fetch(event.request), NAVIGATION_TIMEOUT_MS);
    // The proxy answering for an app that's down counts as down.
    if (response.status >= 502 && response.status <= 504) throw new Error(`upstream ${response.status}`);
    event.waitUntil(keepPage(response.clone()));
    return response;
  } catch {
    const kept = await caches.open(PAGES).then((c) => c.match("/"));
    if (kept) return kept;
    return offlinePage();
  }
}

function offlinePage() {
  const body = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem}</style>
</head><body>
<h1>You're offline</h1>
<p>The list hasn't been saved on this device yet. Open the app once with a connection and it will be.</p>
</body></html>`;
  return new Response(body, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSETS);
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) return cache.put(request, response.clone()).then(() => response);
      return response;
    })
    .catch(() => hit);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return refresh;
}

// ---- Web Push ------------------------------------------------------------------------

// A push is Declarative Web Push JSON (src/notifications/worker.ts):
//   { web_push: 8030, notification: { title, body, navigate, tag, ... } }
// iOS 18.4 and later shows that with no help. This handler is the same thing for
// everyone else, and for older iOS.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { notification: { body: event.data ? event.data.text() : "" } };
  }
  const n = payload.notification || {};
  event.waitUntil(
    self.registration.showNotification(n.title || "Punchlist", {
      body: n.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: n.tag || "punchlist",
      lang: n.lang,
      data: { url: n.navigate || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
