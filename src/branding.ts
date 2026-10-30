import { site } from "./config.server.ts";

/** What the deployment calls the app, and its colour. From the config file. */
export interface Branding {
  name: string;
  /** Under the home-screen icon. */
  shortName: string;
  /** "#rrggbb" */
  themeColor: string;
  hasLogo: boolean;
}

export function branding(): Branding {
  const s = site();
  return { name: s.name, shortName: s.shortName, themeColor: s.themeColor, hasLogo: Boolean(s.logoSvg) };
}
