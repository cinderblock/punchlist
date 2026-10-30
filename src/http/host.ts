/**
 * Only the public host is served. Nothing here builds a URL from Host, but a
 * response to any other name is a DNS-rebinding target: a page on someone's own
 * domain, resolved to this server, would otherwise be same-origin with whatever a
 * LAN browser can reach. The one exception is the container's own health check,
 * which connects to itself by whatever address it has.
 */
export function hostAllowed(host: string | undefined, path: string, publicHost: string): boolean {
  if (path === "/healthz") return true;
  return host?.toLowerCase() === publicHost.toLowerCase();
}
