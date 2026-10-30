import { handleApi } from "../../src/http/api.ts";
import { getResolved } from "../auth.server.ts";
import type { Route } from "./+types/api.v1";

/** A thin door into src/http/api.ts, which owns routing, auth and origin checks. */
export const loader = ({ request, context }: Route.LoaderArgs) => handleApi(request, getResolved(context));
export const action = ({ request, context }: Route.ActionArgs) => handleApi(request, getResolved(context));
