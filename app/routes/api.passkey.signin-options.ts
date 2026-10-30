import { startSignIn } from "../../src/auth-flows.ts";
import { checkCeremonyRate } from "../../src/http/ceremony-rate.ts";
import { assertSameOrigin, ceremonyCookie, isPost, userErrorResponse } from "../auth.server.ts";
import type { Route } from "./+types/api.passkey.signin-options";

export async function action({ request }: Route.ActionArgs) {
  isPost(request);
  assertSameOrigin(request);
  try {
    checkCeremonyRate(request);
  } catch (err) {
    return userErrorResponse(err);
  }
  const { ceremonyId, options } = await startSignIn();
  return Response.json(
    { options },
    { headers: { "Set-Cookie": await ceremonyCookie.serialize(ceremonyId) } },
  );
}
