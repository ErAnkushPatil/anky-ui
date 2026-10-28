/** Version range of the only third-party runtime dependency a copied component may need. Kept in sync with `@erankushpatil/anky-ui`. */
export const FLOATING_UI = "@floating-ui/react@^0.27.0";

export interface RegistryItem {
  /** CLI name, e.g. `selection-palette`. */
  readonly name: string;
  /** Main export, shown in the import hint after adding. */
  readonly exportName: string;
  readonly description: string;
  /** Source files, relative to `@erankushpatil/anky-ui/src`. Copied flat into the target directory under their basename. */
  readonly files: readonly string[];
  /** Other registry items these files import. Installed alongside. */
  readonly registryDependencies: readonly string[];
  /** npm packages (`name@range`) these files import. */
  readonly dependencies: readonly string[];
}

export const REGISTRY: readonly RegistryItem[] = [
  {
    name: "selection-palette",
    exportName: "SelectionPalette",
    description: "Floating AI action bar anchored to the user's text selection.",
    files: ["components/SelectionPalette.tsx"],
    registryDependencies: ["use-selection-anchor", "announce"],
    dependencies: [FLOATING_UI],
  },
  {
    name: "inline-diff",
    exportName: "InlineDiff",
    description: "Live word/char diff with Accept (Cmd+Enter) / Reject (Esc) toolbar.",
    files: ["components/InlineDiff.tsx"],
    registryDependencies: ["diff", "announce"],
    dependencies: [FLOATING_UI],
  },
  {
    name: "ghost-input",
    exportName: "GhostInput",
    description: "Copilot-style textarea with inline ghost-text completions.",
    files: ["components/GhostInput.tsx"],
    registryDependencies: [],
    dependencies: [],
  },
  {
    name: "use-selection-anchor",
    exportName: "useSelectionAnchor",
    description: "Hook exposing the text selection as a floating-ui virtual element.",
    files: ["dom/useSelectionAnchor.ts"],
    registryDependencies: [],
    dependencies: [],
  },
  {
    name: "use-optimistic-ai-state",
    exportName: "useOptimisticAIState",
    description: "Optimistic streaming state with snapshots, rollback and undo/redo.",
    files: ["hooks/useOptimisticAIState.ts"],
    registryDependencies: ["stream-parser"],
    dependencies: [],
  },
  {
    name: "diff",
    exportName: "computeDiff",
    description: "Zero-dependency Myers diff (word and char modes).",
    files: ["diff/myers.ts"],
    registryDependencies: [],
    dependencies: [],
  },
  {
    name: "stream-parser",
    exportName: "streamTextReader",
    description: "Async generator reading SSE or raw text streams.",
    files: ["stream/parser.ts"],
    registryDependencies: [],
    dependencies: [],
  },
  {
    name: "announce",
    exportName: "announce",
    description: "Screen-reader live-region helper used by the components.",
    files: ["a11y/announce.ts"],
    registryDependencies: [],
    dependencies: [],
  },
  {
    name: "stream-providers",
    exportName: "providerTextReader",
    description: "OpenAI, Anthropic and Vercel AI SDK stream decoders.",
    files: ["stream/providers.ts"],
    registryDependencies: ["stream-parser"],
    dependencies: [],
  },
  {
    name: "editor-adapter",
    exportName: "EditorAdapter",
    description: "Shared types for the Tiptap, ProseMirror and Lexical adapters.",
    files: ["adapters/editorAdapter.ts"],
    registryDependencies: [],
    dependencies: [],
  },
  {
    name: "prosemirror-adapter",
    exportName: "createProseMirrorAdapter",
    description: "Use SelectionPalette and InlineDiff with a ProseMirror EditorView.",
    files: ["adapters/prosemirror.ts"],
    registryDependencies: ["editor-adapter"],
    dependencies: [],
  },
  {
    name: "tiptap-adapter",
    exportName: "createTiptapAdapter",
    description: "Use SelectionPalette and InlineDiff with a Tiptap editor.",
    files: ["adapters/tiptap.ts"],
    registryDependencies: ["prosemirror-adapter"],
    dependencies: [],
  },
  {
    name: "lexical-adapter",
    exportName: "createLexicalAdapter",
    description: "Use SelectionPalette and InlineDiff with a Lexical editor.",
    files: ["adapters/lexical.ts"],
    registryDependencies: ["editor-adapter"],
    dependencies: [],
  },
  {
    name: "use-editor-anchor",
    exportName: "useEditorAnchor",
    description: "Selection anchor hook for editor adapters (feeds SelectionPalette's anchor prop).",
    files: ["adapters/useEditorAnchor.ts"],
    registryDependencies: ["editor-adapter", "use-selection-anchor"],
    dependencies: [],
  },
];

export function getItem(name: string): RegistryItem | undefined {
  return REGISTRY.find((item) => item.name === name);
}

/**
 * Expand `names` with their registry dependencies, dependencies first, without duplicates.
 * Throws {@link UnknownItemError} on unknown names.
 */
export function resolveItems(names: readonly string[]): RegistryItem[] {
  const unknown = names.filter((name) => !getItem(name));
  if (unknown.length) throw new UnknownItemError(unknown);

  const ordered: RegistryItem[] = [];
  const visit = (name: string, trail: readonly string[]) => {
    if (ordered.some((item) => item.name === name)) return;
    if (trail.includes(name)) throw new Error(`Registry cycle: ${[...trail, name].join(" -> ")}`);
    const item = getItem(name);
    if (!item) throw new Error(`Registry item "${trail[trail.length - 1]}" depends on unknown item "${name}".`);
    for (const dep of item.registryDependencies) visit(dep, [...trail, name]);
    ordered.push(item);
  };
  for (const name of names) visit(name, []);
  return ordered;
}

export class UnknownItemError extends Error {
  constructor(readonly names: readonly string[]) {
    super(`Unknown component${names.length > 1 ? "s" : ""}: ${names.join(", ")}`);
    this.name = "UnknownItemError";
  }
}

/** `@scope/pkg@^1.0.0` -> `@scope/pkg`. */
export function packageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}
