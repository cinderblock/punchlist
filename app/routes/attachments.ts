import { serveAttachment } from "../../src/attachment-store.ts";
import { errorResponse } from "../../src/http/guard.ts";
import { getActor } from "../auth.server.ts";
import type { Route } from "./+types/attachments";

export function loader({ params, context }: Route.LoaderArgs) {
  try {
    return serveAttachment(getActor(context), params.id);
  } catch (err) {
    return errorResponse(err);
  }
}
