import { notifications } from "@mantine/notifications";

import { clearDeviceCopies } from "../offline/copies.ts";

/**
 * Sign out, then clear what's kept on the device: on a shared tablet the next
 * person mustn't find this one's private tasks in a cached page. A full page load
 * afterwards, so nothing in memory carries over either.
 */
export function SignOutButton({ children }: { children: (signOut: () => void) => React.ReactNode }) {
  const signOut = () => {
    fetch("/signout", { method: "POST", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`sign-out answered ${response.status}`);
        await clearDeviceCopies();
        window.location.assign("/signin");
      })
      .catch(() => notifications.show({ color: "red", message: "Can't reach the server to sign out. Try again with a connection." }));
  };
  return <>{children(signOut)}</>;
}
