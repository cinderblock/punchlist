import { Alert, Text } from "@mantine/core";
import { useEffect, useState } from "react";

import { isIos, isStandalone } from "../pwa/push-client.ts";

const DISMISSED = "pl:install-hint-dismissed";

/** The steps, in iOS's own words. Shared with the notifications page. */
export function InstallSteps() {
  return (
    <Text size="sm" component="ol" m={0} pl="md">
      <li>In Safari, tap the Share button.</li>
      <li>Choose Add to Home Screen, then Add.</li>
      <li>Open the app from your Home Screen, and turn notifications on under Settings.</li>
    </Text>
  );
}

/**
 * On an iPhone, in the browser. Notifications only work in the installed app
 * (iOS 16.4+), so say so plainly once, rather than offering a button that fails.
 */
export function InstallHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      setShow(isIos() && !isStandalone() && !window.localStorage.getItem(DISMISSED));
    } catch {
      setShow(false);
    }
  }, []);
  if (!show) return null;
  return (
    <Alert
      mb="md"
      withCloseButton
      closeButtonLabel="Dismiss"
      title="Add this to your Home Screen"
      onClose={() => {
        setShow(false);
        try {
          window.localStorage.setItem(DISMISSED, "1");
        } catch {
          // It'll just come back next time.
        }
      }}
    >
      <Text size="sm" mb={4}>
        It opens like an app, and it's the only way an iPhone can get notifications from it.
      </Text>
      <InstallSteps />
    </Alert>
  );
}
