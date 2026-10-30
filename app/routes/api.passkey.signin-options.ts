import { startSignIn } from "../../src/auth-flows.ts";
import { CEREMONIES_PER_MINUTE, checkSharedRate } from "../../src/rate-limit.ts";
import { assertSameOrigin, ceremonyCookie, isPost, userErrorResponse } from "../auth.server.ts";
import type { Route } from "./+types/api.passkey.signin-options";

export async function action({ request }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  try {
    // No actor yet, and no address worth trusting: one shared brake on floods.
    checkSharedRate("ceremonies", CEREMONIES_PER_MINUTE);
  } catch (err) {
    return userErrorResponse(err);
  }
  const { ceremonyId, options } = await startSignIn();
  return Response.json(
    { options },
    { headers: { "Set-Cookie": await ceremonyCookie.serialize(ceremonyId) } },
  );
}
