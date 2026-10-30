import { branding } from "../../src/branding.ts";

/**
 * The PWA manifest, generated from the deployment's config.
 *
 * Icons are referenced by fixed paths under /icons/. A deployment that wants its
 * own bind-mounts them there; the repo ships generic ones so an unbranded
 * install is still installable.
 */
export function loader() {
  const brand = branding();
  const manifest = {
    name: brand.name,
    short_name: brand.shortName,
    description: `${brand.name}: what needs doing here.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: brand.themeColor,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      "Content-Type": "application/manifest+json",
      // Short cache: a config change should show up on the next launch, but
      // this shouldn't be re-fetched on every navigation either.
      "Cache-Control": "public, max-age=300",
    },
  });
}
