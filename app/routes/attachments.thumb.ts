import { serveThumb } from "../../src/attachment-store.ts";
import { errorResponse } from "../../src/http/guard.ts";
import { getActor } from "../auth.server.ts";
import type { Route } from "./+types/attachments.thumb";

export function loader({ params, context }: Route.LoaderArgs) {
  try {
    return serveThumb(getActor(context), params.id);
  } catch (err) {
    return errorResponse(err);
  }
}
