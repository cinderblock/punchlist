import { notifications } from "@mantine/notifications";

import { checkQueue } from "../offline/check-queue.ts";
import { clearDeviceCopies } from "../offline/copies.ts";

/**
 * Sign out, then clear what's kept on the device: on a shared tablet the next
 * person mustn't find this one's private tasks in a cached page. A full page load
 * afterwards, so nothing in memory carries over either.
 */
export function SignOutButton({ children }: { children: (signOut: () => void) => React.ReactNode }) {
  const signOut = async () => {
    // Give queued check-offs a last chance, and don't lose them without saying so.
    const queue = checkQueue();
    await queue.flush();
    const unsent = queue.pending().length;
    if (unsent > 0 && !window.confirm(`${unsent} check-off${unsent === 1 ? " hasn't" : "s haven't"} reached the server yet. Signing out discards ${unsent === 1 ? "it" : "them"}. Sign out anyway?`)) return;
    try {
      const response = await fetch("/signout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(`sign-out answered ${response.status}`);
      await clearDeviceCopies();
      window.location.assign("/signin");
    } catch {
      notifications.show({ color: "red", message: "Can't reach the server to sign out. Try again with a connection." });
    }
  };
  return <>{children(() => void signOut())}</>;
}
