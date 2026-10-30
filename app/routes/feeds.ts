import { renderFeed } from "../../src/feeds.ts";
import type { Route } from "./+types/feeds";

/** /feeds/<random>.ics. A bad token and a dead one look the same. */
export function loader({ params }: Route.LoaderArgs) {
  const token = params.file.endsWith(".ics") ? params.file.slice(0, -4) : "";
  const body = token ? renderFeed(token) : null;
  if (body == null) return new Response("Not found\n", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return new Response(body, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, no-store" } });
}
