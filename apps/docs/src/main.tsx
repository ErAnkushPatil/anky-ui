import { StrictMode, useSyncExternalStore, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Accessibility } from "./Accessibility";
import { Adapters } from "./Adapters";
import { Benchmarks } from "./Bench";
import { Components, Home, State } from "./Pages";
import { Recipes } from "./Recipes";
import "./styles.css";

const PAGES: Array<{ path: string; title: string; element: () => ReactElement }> = [
  { path: "/", title: "Overview", element: Home },
  { path: "/components", title: "Components", element: Components },
  { path: "/state", title: "useOptimisticAIState", element: State },
  { path: "/recipes", title: "Streaming recipes", element: Recipes },
  { path: "/adapters", title: "Editor adapters", element: Adapters },
  { path: "/accessibility", title: "Accessibility", element: Accessibility },
  { path: "/benchmarks", title: "Benchmarks", element: Benchmarks },
];

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const currentPath = () => window.location.hash.replace(/^#/, "") || "/";

function Docs() {
  const path = useSyncExternalStore(subscribe, currentPath, () => "/");
  const page = PAGES.find((p) => p.path === path) ?? PAGES[0]!;
  const Page = page.element;
  document.title = `${page.title} · Anky UI Docs`;

  return (
    <div className="layout">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <nav className="nav" aria-label="Documentation">
        <h1>Anky UI</h1>
        {PAGES.map((p) => (
          <a key={p.path} href={`#${p.path}`} aria-current={p.path === page.path ? "page" : undefined}>
            {p.title}
          </a>
        ))}
      </nav>
      <main id="main" tabIndex={-1}>
        <Page key={page.path} />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Docs />
  </StrictMode>,
);
