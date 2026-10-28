import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { StressTest } from "./StressTest";
import "./styles.css";

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** `#stress` opens the token stress test; anything else is the playground. */
function Root() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return hash === "#stress" ? <StressTest /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
