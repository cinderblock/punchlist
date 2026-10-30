import { startEnrollment } from "../../src/auth-flows.ts";
import {
  assertSameOrigin,
  ceremonyCookie,
  getAuth,
  isPost,
  joinCookie,
  readCookie,
  readJson,
  userErrorResponse,
} from "../auth.server.ts";
import type { Route } from "./+types/api.passkey.register-options";

/**
 * Begin registering a passkey — either through a one-time link (the join
 * cookie) or for the signed-in person's own account.
 */
export async function action({ request, context }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  const body = await readJson(request);

  try {
    const { ceremonyId, options } = await startEnrollment({
      // The page says which it means. Anything else is the safe one: a link is only
      // redeemed when a link's page asked to.
      intent: body.intent === "link" ? "link" : "self",
      confirmedSwitch: body.confirmedSwitch === true,
      joinToken: await readCookie(joinCookie, request),
      currentUser: getAuth(context)?.user ?? null,
      name: body.name,
    });
    return Response.json(
      { options },
      { headers: { "Set-Cookie": await ceremonyCookie.serialize(ceremonyId) } },
    );
  } catch (err) {
    return userErrorResponse(err);
  }
}
