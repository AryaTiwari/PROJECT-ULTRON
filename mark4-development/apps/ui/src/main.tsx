import { createRoot } from "react-dom/client";
import { App } from "./App";
import { UiErrorBoundary } from "./UiErrorBoundary";
import "./styles.css";

const rootElement=document.getElementById("root");
if(!rootElement)throw new Error("ULTRON_ROOT_MISSING");

createRoot(rootElement).render(
  <UiErrorBoundary>
    <App />
  </UiErrorBoundary>
);
