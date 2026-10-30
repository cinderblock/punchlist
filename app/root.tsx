import {
  ColorSchemeScript,
  MantineProvider,
  type MantineColorShade,
  type MantineColorsTuple,
  createTheme,
  mantineHtmlProps,
} from "@mantine/core";
import { generateColorsMap } from "@mantine/colors-generator";
import { Notifications } from "@mantine/notifications";
import { useEffect, useMemo } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError, useRouteLoaderData } from "react-router";

import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";

import { branding } from "../src/branding.ts";
import { config } from "../src/config.server.ts";
import type { Route } from "./+types/root";
import { authMiddleware, defaultHeadersMiddleware } from "./auth.server.ts";
import { MOTION, motionCss } from "./motion.ts";
import { isOfflineError, readCopy, writeCopy } from "./offline/copies.ts";
import { startAutoUpdate } from "./pwa/auto-update.ts";
import { UpdateReady } from "./pwa/UpdateReady.tsx";
import { initMiddleware } from "./server-init.ts";

// Order matters: the database must be open before the session is resolved.
// Middleware (unlike the root loader) also runs for the JSON API routes.
export const middleware: Route.MiddlewareFunction[] = [defaultHeadersMiddleware, initMiddleware, authMiddleware];

/**
 * Branding reaches the client through the root loader rather than being compiled
 * in, so one image serves any space. Nothing secret goes here.
 *
 * The ten-shade ramp is generated on the server so the colour library stays out
 * of the browser bundle.
 */
export function loader() {
  const brand = branding();
  const ramp = generateColorsMap(brand.themeColor);
  return {
    branding: {
      name: brand.name,
      shortName: brand.shortName,
      themeColor: brand.themeColor,
      hasLogo: brand.hasLogo,
      palette: ramp.colors.map((c) => c.hex()),
      // The shade the chosen colour itself landed on: filled buttons use it, so
      // a dark or light brand colour shows as picked rather than shade 6.
      primaryShade: ramp.baseColorIndex,
    },
    timezone: config.timezone,
  };
}

const ROOT_COPY = "root";

/** Offline, the last copy of the branding and zone stands in. */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  try {
    const fresh = await serverLoader();
    writeCopy(ROOT_COPY, fresh);
    return fresh;
  } catch (err) {
    const copy = isOfflineError(err) ? readCopy<Awaited<ReturnType<typeof loader>>>(ROOT_COPY) : null;
    if (copy) return copy;
    throw err;
  }
}

export function meta({ loaderData }: Route.MetaArgs) {
  const name = loaderData?.branding.name ?? FALLBACK_NAME;
  return [{ title: name }, { name: "description", content: `${name}: what needs doing here.` }];
}

const FALLBACK_NAME = "Punchlist";
const FALLBACK_THEME_COLOR = "#2f9e44";

export function Layout({ children }: { children: React.ReactNode }) {
  // `useRouteLoaderData` rather than `useLoaderData`: Layout also wraps the
  // ErrorBoundary, and when the root loader itself failed there is no loader
  // data to read. This returns undefined instead of throwing.
  const data = useRouteLoaderData<typeof loader>("root");
  const themeColor = data?.branding.themeColor ?? FALLBACK_THEME_COLOR;
  const shortName = data?.branding.shortName ?? FALLBACK_NAME;

  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover so the layout can reach under the notch; the
            safe-area insets are respected in CSS rather than by letterboxing. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content={themeColor} />
        {/* iOS ignores the manifest's display mode; these make a home-screen
            launch open without Safari chrome, under the right name. */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content={shortName} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" type="image/png" href="/icons/icon-192.png" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <ColorSchemeScript defaultColorScheme="auto" />
        <style dangerouslySetInnerHTML={{ __html: motionCss }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  const { palette, primaryShade } = loaderData.branding;

  const theme = useMemo(
    () =>
      createTheme({
        primaryColor: "brand",
        colors: { brand: palette as unknown as MantineColorsTuple },
        primaryShade: primaryShade as MantineColorShade,
        // Pick black or white text per shade, so a light brand colour still
        // produces readable buttons.
        autoContrast: true,
        // Mantine defaults this to false, which means every one of its
        // transitions ignores the setting. On, they collapse to nothing.
        respectReducedMotion: true,
        components: {
          // Phone-first: bigger default hit targets than Mantine's desktop defaults.
          Button: { defaultProps: { size: "md" } },
          Modal: { defaultProps: { transitionProps: { transition: "pop", duration: MOTION.base, timingFunction: MOTION.entrance } } },
        },
      }),
    [palette, primaryShade],
  );

  useEffect(() => {
    // The worker is what makes the app installable and usable offline, and what
    // replaces itself when a release lands. Not in development: a caching worker
    // and Vite's hot reloading fight each other.
    if (import.meta.env.DEV) return;
    startAutoUpdate();
  }, []);

  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="bottom-center" />
      <Outlet />
      <UpdateReady />
    </MantineProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  let heading = "Something went wrong";
  // Never surface a raw stack; the server log has it.
  let detail = "The app hit an unexpected error.";
  if (isOfflineError(error)) {
    heading = "You're offline";
    detail = "This page needs a connection. The list you last saw is still on the home screen.";
  } else if (isRouteErrorResponse(error)) {
    heading = error.status === 404 ? "Page not found" : error.status === 403 ? "Not allowed" : `Error ${error.status}`;
    detail = typeof error.data === "string" && error.data ? error.data : error.statusText || (error.status === 404 ? "There's nothing at this address." : detail);
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "36rem", margin: "0 auto" }}>
      <h1>{heading}</h1>
      <p>{detail}</p>
      <p>
        <a href="/">Back to the app</a>
      </p>
    </main>
  );
}
