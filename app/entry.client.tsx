import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

import { installErrorReporting, reportError } from "./reporting/report.ts";

installErrorReporting();

// React's defaults log these. Giving it handlers replaces that, so the log stays here.
const fromReact = (error: unknown) => {
  console.error(error);
  reportError("react", error);
};

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter onError={(error) => reportError("router", error)} />
    </StrictMode>,
    { onCaughtError: fromReact, onUncaughtError: fromReact, onRecoverableError: fromReact },
  );
});
