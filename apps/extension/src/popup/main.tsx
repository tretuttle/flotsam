import { Suspense, use } from "react";
import { createRoot } from "react-dom/client";
import type { Environment, ToolboxClosedReason, ToolboxState } from "../../experiment/contract.ts";
import "../styles.css";
import "./popup.css";

type Reading =
  | { readonly kind: "ready"; readonly environment: Environment }
  | { readonly kind: "api-missing" }
  | { readonly kind: "no-active-tab" }
  | { readonly kind: "failed"; readonly message: string };

const readEnvironment = async (): Promise<Reading> => {
  const api = browser.harAnytime;
  if (api === undefined) return { kind: "api-missing" };
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return { kind: "no-active-tab" };
    return { kind: "ready", environment: await api.getEnvironment(tab.id) };
  } catch (error) {
    return { kind: "failed", message: String(error) };
  }
};

const closedToolboxText: Record<ToolboxClosedReason, string> = {
  "no-such-tab": "This tab cannot be inspected",
  "devtools-not-started": "Not opened since the browser started",
  "no-toolbox-for-tab": "Not open on this tab",
};

const toolboxText = (toolbox: ToolboxState): string =>
  toolbox.open ? `Open on this tab (${toolbox.host})` : closedToolboxText[toolbox.reason];

const problemText = {
  "api-missing":
    "The One-Click HAR browser API is not available. Set extensions.experiments.enabled to true in about:config, then restart the browser.",
  "no-active-tab": "There is no active tab in this window.",
} as const;

const EnvironmentFacts = ({ environment }: { readonly environment: Environment }) => (
  <dl className="facts">
    <dt>Browser</dt>
    <dd>
      {environment.browser.name} {environment.browser.version}
    </dd>
    <dt>Build ID</dt>
    <dd>{environment.browser.buildId}</dd>
    <dt>DevTools</dt>
    <dd>{toolboxText(environment.toolbox)}</dd>
  </dl>
);

const Popup = ({ reading }: { readonly reading: Promise<Reading> }) => {
  const result = use(reading);
  return (
    <>
      {result.kind === "ready" ? (
        <EnvironmentFacts environment={result.environment} />
      ) : (
        <p className="facts">
          {result.kind === "failed" ? result.message : problemText[result.kind]}
        </p>
      )}
      <button type="button" className="export" disabled>
        Export HAR
      </button>
      <p className="muted">
        Export is not built yet. This version only checks that the extension can reach the browser.
      </p>
    </>
  );
};

createRoot(document.getElementById("root")!).render(
  <main className="popup">
    <h1>One-Click HAR</h1>
    <Suspense fallback={<p className="muted">Reading browser state.</p>}>
      <Popup reading={readEnvironment()} />
    </Suspense>
  </main>,
);
