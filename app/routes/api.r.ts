/**
 * /api/r, short enough to read out loud: the way out when an installed copy is
 * stuck on a broken service worker. Under /api/ because the worker never answers
 * those, so this still reaches the server whatever state the worker is in. It
 * drops the worker and its caches and starts again. Sign-in and queued check-offs
 * are left alone. Serves no task data, so it needs no sign-in.
 */
const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Repairing</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem}</style>
</head><body><h1>Repairing the app</h1><p id="status">One moment.</p>
<script>
(async () => {
  try {
    const workers = await navigator.serviceWorker?.getRegistrations() ?? [];
    await Promise.all(workers.map((w) => w.unregister()));
    const names = await caches?.keys() ?? [];
    await Promise.all(names.map((n) => caches.delete(n)));
  } catch {}
  location.replace("/");
})();
</script></body></html>`;

export function loader() {
  return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
