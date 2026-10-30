import { useFetcher } from "react-router";

import { clearDeviceCopies } from "../offline/copies.ts";

/**
 * Signing out also clears what's kept on the device, first: on a shared tablet
 * the next person mustn't find this one's private tasks in a cached page.
 */
export function SignOutButton({ children }: { children: (signOut: () => void) => React.ReactNode }) {
  const fetcher = useFetcher();
  const signOut = () => {
    void clearDeviceCopies().then(() => fetcher.submit(null, { method: "post", action: "/signout" }));
  };
  return <>{children(signOut)}</>;
}
