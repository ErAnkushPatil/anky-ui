import { useState, type ReactNode } from "react";

export function CodeBlock({ code, lang = "tsx" }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context); the text stays selectable.
    }
  };
  return (
    <div className="code">
      <button type="button" className="code-copy" onClick={copy} aria-label={`Copy ${lang} code`}>
        {copied ? "Copied" : "Copy"}
      </button>
      <pre tabIndex={0}>
        <code data-lang={lang}>{code}</code>
      </pre>
    </div>
  );
}

export function Demo({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="demo" aria-label={`Live demo: ${title}`}>
      <header>
        <span className="demo-badge">Live demo</span> {title}
      </header>
      <div className="demo-body">{children}</div>
      {note && <footer>{note}</footer>}
    </section>
  );
}

export function PropsTable({ rows }: { rows: Array<[name: string, type: string, description: string]> }) {
  return (
    <table className="props">
      <thead>
        <tr>
          <th scope="col">Prop</th>
          <th scope="col">Type</th>
          <th scope="col">Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, type, description]) => (
          <tr key={name}>
            <th scope="row">
              <code>{name}</code>
            </th>
            <td>
              <code>{type}</code>
            </td>
            <td>{description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Callout({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "warn" }) {
  return (
    <aside className={`callout callout-${kind}`} role="note">
      {children}
    </aside>
  );
}
