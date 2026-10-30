import { trustedClientIpHeader } from "../config.server.ts";
import { CEREMONIES_PER_ADDRESS_PER_MINUTE, CEREMONIES_PER_MINUTE, checkSharedRate } from "../rate-limit.ts";

/**
 * A passkey ceremony has no actor yet, so its rate limit needs some other key.
 * With no client address to go on, everyone shares one bucket, and anyone can spend
 * it. A deployment whose proxy overwrites a header with the client's address can
 * name it in TRUSTED_CLIENT_IP_HEADER, and each address gets its own.
 *
 * Unset means the header is ignored, like the perimeter header. This value picks a
 * rate-limit bucket and does nothing else: no permission anywhere reads it.
 */
const ADDRESS = /^[0-9a-fA-F:.]{2,45}$/;

export function ceremonyRateKey(request: Request): string | null {
  const header = trustedClientIpHeader();
  const value = header ? request.headers.get(header) : null;
  // Not one plain address (a list, nothing at all): the proxy isn't doing as promised.
  return value && ADDRESS.test(value) ? value.toLowerCase() : null;
}

export function checkCeremonyRate(request: Request, now?: number): void {
  const address = ceremonyRateKey(request);
  if (address) checkSharedRate(`ceremonies:${address}`, CEREMONIES_PER_ADDRESS_PER_MINUTE, now);
  else checkSharedRate("ceremonies", CEREMONIES_PER_MINUTE, now);
}
