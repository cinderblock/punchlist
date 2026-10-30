import { site } from "../../src/config.server.ts";

/**
 * The logo from the config file. Served as an image with a sandbox, so even a
 * logo with a script in it can't run. It's never inlined into a page.
 */
export function loader() {
  const svg = site().logoSvg;
  if (!svg) return new Response("Not found", { status: 404 });
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "public, max-age=300",
    },
  });
}
