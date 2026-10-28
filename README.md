# Anky UI

[![npm](https://img.shields.io/npm/v/@erankushpatil/anky-ui?label=%40erankushpatil%2Fanky-ui)](https://www.npmjs.com/package/@erankushpatil/anky-ui)
[![npm cli](https://img.shields.io/npm/v/anky-ui?label=anky-ui%20cli)](https://www.npmjs.com/package/anky-ui)
[![license](https://img.shields.io/badge/license-ISC-blue.svg)](./LICENSE)
[![types](https://img.shields.io/badge/types-TypeScript-3178c6.svg)](#api-reference)

**Anky UI is an AI UI library for React: ambient, inline AI primitives.** Select text to open a floating AI action palette, stream a rewrite into a live inline diff, accept or reject it, get Copilot-style ghost text autocomplete in a textarea, and undo/redo every AI change.

Headless by default, Tailwind-ready, zero runtime dependencies besides `@floating-ui/react`. Bring your own model endpoint. Works with Next.js (App Router and Pages), Vite and any React 18/19 app.

- Floating AI action palette anchored to the user's text selection (Cursor-like inline prompt)
- React inline diff with streaming tokens, word or character mode
- Ghost text autocomplete textarea with Tab / → to accept
- Optimistic AI state with rollback, undo/redo history and accept/reject
- Copy-paste distribution via CLI in the shadcn style: `npx anky-ui add ...`

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Components](#components)
  - [SelectionPalette](#selectionpalette)
  - [InlineDiff](#inlinediff)
  - [GhostInput](#ghostinput)
- [Hooks and utilities](#hooks-and-utilities)
  - [useOptimisticAIState](#useoptimisticaistate)
  - [useSelectionAnchor](#useselectionanchor)
  - [computeDiff](#computediff)
  - [streamTextReader](#streamtextreader)
- [Provider streaming recipes](#provider-streaming-recipes)
- [Editor adapters](#editor-adapters)
- [Accessibility](#accessibility)
- [Styling and Tailwind](#styling-and-tailwind)
- [CLI](#cli)
- [Server and Next.js notes](#server-and-nextjs-notes)
- [Playground](#playground)
- [Development](#development)
- [Contributing](#contributing)
- [FAQ](#faq)
- [Keywords](#keywords)
- [License](#license)

## Install

```bash
npm install @erankushpatil/anky-ui
```

Requires React and React DOM 18 or 19. `@floating-ui/react` is installed as a dependency.

Prefer to own the source? Copy the components into your project instead:

```bash
npx anky-ui add selection-palette
npx anky-ui add inline-diff
npx anky-ui add ghost-input
```

## Quick start

Highlight text, pick an action, watch the rewrite stream in, then accept or reject it.

```tsx
"use client";

import {
  InlineDiff,
  SelectionPalette,
  useOptimisticAIState,
} from "@erankushpatil/anky-ui";

export function Editor() {
  const ai = useOptimisticAIState({ initialState: { original: "", modified: "" } });

  function run(prompt: string, selectedText: string) {
    void ai.mutateWithStream(
      (signal) =>
        fetch("/api/rewrite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, text: selectedText }),
          signal,
        }),
      (state, chunk) => ({ original: selectedText, modified: state.modified + chunk }),
    );
  }

  return (
    <>
      <article contentEditable suppressContentEditableWarning>
        Select any sentence in this paragraph to try the AI palette.
      </article>

      <SelectionPalette onSelectPrompt={run} />

      {ai.currentState.original && (
        <InlineDiff
          originalText={ai.currentState.original}
          modifiedText={ai.currentState.modified}
          isStreaming={ai.isStreaming}
          onAccept={ai.accept}
          onReject={ai.reject}
        />
      )}
    </>
  );
}
```

The endpoint can return raw UTF-8 text or Server-Sent Events whose `data:` fields hold text. Convert provider-specific JSON (OpenAI, Anthropic, ...) to text on your server.

## Components

### SelectionPalette

A floating bar anchored to the highlighted text, built on `@floating-ui/react`. It flips and clamps to the viewport, follows scrolling overflow parents, and hides when the selection scrolls out of view.

```tsx
<SelectionPalette
  actions={[
    { label: "Fix Grammar", prompt: "Fix the grammar of the following text." },
    { label: "Shorten", prompt: "Make this shorter.", icon: "↘" },
  ]}
  onSelectPrompt={(prompt, selectedText) => runAI(prompt, selectedText)}
  customInputPlaceholder="Ask AI to edit…"
  containerRef={editorRef}
/>
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `onSelectPrompt` | `(prompt: string, selectedText: string) => void` | required | Called with a preset prompt or the freeform input, and the highlighted text. |
| `actions` | `Array<{ label: string; icon?: ReactNode; prompt: string }>` | Fix Grammar, Shorten, Translate | Preset pills. Pass `[]` for none. |
| `customInputPlaceholder` | `string` | `"Ask AI to edit…"` | Placeholder of the freeform input. |
| `children` | `ReactNode` | none | Extra content at the end of the bar. |
| `containerRef` | `RefObject<HTMLElement \| null>` | `document.body` | Only selections inside this element open the palette. |
| `minChars` | `number` | `1` | Minimum selected characters (whitespace-trimmed). |
| `enabled` | `boolean` | `true` | Disable to detach all listeners. |
| `placement` | floating-ui `Placement` | `"top"` | Preferred side. |
| `sideOffset` | `number` | `8` | Gap to the selection, in px. |
| `closeOnSelect` | `boolean` | `true` | Close and restore the selection after a prompt is chosen. |
| `classNames` | `{ root?, actions?, action?, actionIcon?, input? }` | none | Extra classes per slot. |
| `aria-label` | `string` | `"AI actions"` | Accessible name of the toolbar. |

Keyboard: `Enter` in the input submits (ignored during IME composition). `Escape` closes the palette and returns focus and the selection to the editor. Arrow keys, `Home` and `End` move between pills.

Semantic classes: `anky-ui-palette-root`, `anky-ui-palette-actions`, `anky-ui-palette-action`, `anky-ui-palette-action-icon`, `anky-ui-palette-input`. Use `StyledSelectionPalette` for the Tailwind preset.

### InlineDiff

Live word or character comparison between the original and a streaming rewrite, with Accept and Reject controls.

```tsx
<InlineDiff
  originalText={original}
  modifiedText={modified}
  mode="word"
  isStreaming={isStreaming}
  onAccept={() => commit(modified)}
  onReject={() => rollback()}
/>
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `originalText` | `string` | required | Text before the edit. |
| `modifiedText` | `string` | required | Text after the edit (may be partial while streaming). |
| `onAccept` | `() => void` | required | Accept. Triggered by the button or `Cmd/Ctrl+Enter`. Disabled while streaming. |
| `onReject` | `() => void` | required | Reject. Triggered by the button or `Escape`. |
| `mode` | `"word" \| "char"` | `"word"` | Diff granularity. |
| `isStreaming` | `boolean` | `false` | Pulses the diff, disables Accept, and shows the not-yet-rewritten tail as pending. |
| `toolbar` | `"floating" \| "inline" \| "none"` | `"floating"` | Where Accept / Reject render. |
| `toolbarPlacement` | floating-ui `Placement` | `"bottom-start"` | Floating toolbar placement. |
| `shortcuts` | `boolean` | `true` | Global `Cmd/Ctrl+Enter` and `Escape`. Ignored while typing in another field. |
| `unstyled` | `boolean` | `false` | Drop the built-in red and green colours. |
| `classNames` | `{ root?, delete?, insert?, pending?, toolbar?, action?, accept?, reject?, kbd? }` | none | Extra classes per slot. |
| `acceptLabel`, `rejectLabel` | `ReactNode` | `"Accept"`, `"Reject"` | Button labels. |

Deletions render as `<del class="anky-ui-diff-delete">` (red, strikethrough) and insertions as `<ins class="anky-ui-diff-insert">` (green). Theme with CSS variables `--anky-ui-diff-delete-bg`, `--anky-ui-diff-delete-fg`, `--anky-ui-diff-insert-bg` and `--anky-ui-diff-insert-fg`. The pulse uses the Web Animations API and respects `prefers-reduced-motion`. Use `StyledInlineDiff` for the Tailwind toolbar preset.

### GhostInput

Copilot-style inline autocomplete. A bottom layer renders your text plus a faint ghost suggestion (`#9CA3AF`); a transparent `<textarea>` on top handles input, caret and selection.

```tsx
const [value, setValue] = useState("");

<GhostInput
  value={value}
  onChange={setValue}
  debounceMs={300}
  placeholder="Start typing…"
  className="rounded-lg border p-3 font-sans text-sm leading-6"
  fetchSuggestion={async (current, { signal }) => {
    const res = await fetch("/api/complete", {
      method: "POST",
      body: JSON.stringify({ text: current }),
      signal,
    });
    return res.text(); // only the continuation, not the full text
  }}
/>;
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `value` | `string` | required | Controlled value. |
| `onChange` | `(value: string) => void` | required | Called on every edit and when a suggestion is accepted. |
| `fetchSuggestion` | `(current: string, options: { signal: AbortSignal }) => Promise<string>` | required | Return the text to append. Return `""` for none. |
| `debounceMs` | `number` | `300` | Idle time after the last keystroke before fetching. |
| `onSuggestionError` | `(error: unknown) => void` | none | Fetch failures never surface in the UI. |
| `onAcceptSuggestion` | `(suggestion: string) => void` | none | Called after Tab or → accepts. |
| `className`, `style` | | none | Applied to the root, which owns font, line-height, letter-spacing, padding, border and colour. Both layers inherit from it so they always line up. |

All native `<textarea>` props (such as `rows`, `placeholder`, `disabled`) are forwarded. A `ref` exposes `{ textarea, acceptSuggestion(), dismissSuggestion() }`.

Keyboard: `Tab` or `ArrowRight` with the caret at the end accepts. `Escape` clears the suggestion. Typing that matches the suggestion keeps the rest visible; anything else invalidates it. Stale responses are discarded. Override the colour with `--anky-ui-ghost-color`.

## Hooks and utilities

### useOptimisticAIState

Optimistic state for streamed AI output with snapshot rollback and a 20-entry undo/redo history.

```tsx
const ai = useOptimisticAIState({
  initialState: { text: "" },
  endpoint: "/api/rewrite", // optional, used by streamFromEndpoint
  onStateChange: (state) => save(state),
});

await ai.mutateWithStream(
  (signal) => fetch("/api/rewrite", { method: "POST", signal }),
  (state, chunk) => ({ text: state.text + chunk }),
);
```

| Member | Description |
| --- | --- |
| `currentState` | Optimistic state, including partially streamed output. |
| `confirmedState` | Last state committed with `accept()`. |
| `history` | `{ past, future }` undo and redo stacks, 20 entries each. |
| `isStreaming`, `error` | Stream status and the last failure or user abort. |
| `canUndo`, `canRedo` | Whether history navigation is possible. |
| `mutateWithStream(source, transformFn, options?)` | Captures an atomic snapshot, sets `isStreaming`, folds each token in with `transformFn`. On error or abort it rolls back to the snapshot and sets `error`. Returns an outcome and never rejects. |
| `streamFromEndpoint(body, transformFn, options?)` | POSTs JSON to `endpoint` and streams the response through `mutateWithStream`. |
| `abort()` | Cancel the in-flight stream and roll back. |
| `undo()`, `redo()` | Move through history. While streaming, `undo()` cancels the stream. |
| `accept()` | Commit `currentState` as the new baseline and clear history. |
| `reject()` | Revert to `confirmedState` (undoable). |
| `update(next)` | Synchronous, undoable change, such as a manual user edit. |

Concurrency: the last call wins. Starting a stream while another is running cancels the older one, rolls it back, and builds the new one on the same pre-mutation snapshot. Stale streams can never write state. `source` accepts a `Response`, a `ReadableStream`, a promise of either, or a factory `(signal) => ...` so the hook can abort the underlying `fetch`.

### useSelectionAnchor

The primitive behind `SelectionPalette`. It returns a floating-ui virtual element for the current text selection.

```tsx
const { isOpen, selectedText, virtualElement, close, restoreSelection } = useSelectionAnchor({
  minChars: 3,
  containerRef: editorRef,
});
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Detach all listeners and reset state when `false`. |
| `minChars` | `1` | Minimum whitespace-trimmed selection length. |
| `containerRef` | `document.body` | Only selections inside this element are tracked. |
| `floatingRef` | none | Your floating element. Focusing or clicking inside it keeps the anchor open. |

Behaviour: `selectionchange` is debounced by 100 ms so dragging doesn't flicker; collapsed or too-short selections are ignored; both `mouseup` and `touchend` are handled without double-firing; the rectangle is recalculated on scroll and the anchor hides when the selection leaves the viewport. The virtual element is created only inside effects, so it is safe for server rendering and hydration. `restoreSelection()` re-selects the original text using saved range offsets, for example after an AI run re-rendered it, and returns `false` if the text can't be found.

### computeDiff

```ts
import { computeDiff, type DiffSegment } from "@erankushpatil/anky-ui";

const segments: DiffSegment[] = computeDiff("The quick fox", "The swift fox", "word");
// [{ type: "equal", value: "The " }, { type: "delete", value: "quick" },
//  { type: "insert", value: "swift" }, { type: "equal", value: " fox" }]
```

`DiffSegment = { type: "equal" | "insert" | "delete"; value: string }`. Zero-dependency Myers diff with `"word"` and `"char"` modes, a work budget that bounds worst-case latency and memory (pass `{ maxCost }` as the fourth argument), and no module-level state.

### streamTextReader

```ts
import { streamTextReader } from "@erankushpatil/anky-ui";

const controller = new AbortController();
for await (const token of streamTextReader(await fetch(url), { signal: controller.signal })) {
  output += token;
}
```

Accepts a `ReadableStream<Uint8Array>` or a `Response`. Decodes with `TextDecoderStream` or `TextDecoder`, handles multi-byte characters split across chunks, strips `data:` prefixes automatically for SSE, passes raw text through unchanged, and ends on `[DONE]`. Options: `signal`, `framing` (`"auto"`, `"sse"` or `"raw"`), `doneSentinel`. On abort it cancels the source and rejects with `signal.reason`.

## Provider streaming recipes

`providerTextReader` and `providerTextStream` decode vendor wire formats into plain text tokens, so you can point the hooks straight at a provider response.

```ts
import { providerTextStream, useOptimisticAIState } from "@erankushpatil/anky-ui";

const ai = useOptimisticAIState({ initialState: "" });
ai.mutateWithStream(
  async () => providerTextStream(await fetch("/api/chat", { method: "POST", body }), "openai"),
  (_current, chunk) => chunk,
  { framing: "raw" },
);
```

| Format | Value | Notes |
| --- | --- | --- |
| OpenAI | `"openai"` | Chat Completions deltas and Responses API `output_text.delta`. |
| Anthropic | `"anthropic"` | `content_block_delta` text deltas. Stream errors raise `ProviderStreamError`. |
| Vercel AI SDK | `"ai-sdk"` | v5 UI-message SSE (`text-delta`), v4 data stream (`0:"..."`) and plain text responses. |

Full server and client examples are on the **Streaming recipes** docs page.

## Editor adapters

`SelectionPalette` and `InlineDiff` work on plain DOM text. For rich-text editors, wrap the editor in an adapter and pass the result of `useEditorAnchor` to the palette. Adapters are structurally typed, so Anky UI never installs Tiptap, ProseMirror or Lexical.

```tsx
import { SelectionPalette, createTiptapAdapter, useEditorAnchor } from "@erankushpatil/anky-ui";

const adapter = useMemo(() => (editor ? createTiptapAdapter(editor) : null), [editor]);
const anchor = useEditorAnchor(adapter);

<SelectionPalette anchor={anchor} onSelectPrompt={async (prompt, text) => anchor.replaceSelection(await rewrite(prompt, text))} />;
```

Also available: `createProseMirrorAdapter(view, { setSelection })` and `createLexicalAdapter(editor, { $getSelection, $isRangeSelection, $createRangeSelection, $setSelection })`. Implement the small `EditorAdapter` interface for any other editor. Replacement refuses when the document changed under the range. The adapters are tested against structural fakes, so verify them against your editor version.

## Accessibility

- `InlineDiff` is a `role="group"` labelled "AI suggested edit" and announces progress and the final insertion/deletion counts through a polite live region.
- `SelectionPalette` is a labelled toolbar with arrow-key navigation, announces when it opens, and `Alt+/` moves focus into it. `Escape` closes it and returns focus to the editor.
- `GhostInput` announces suggestions through its own live region.
- `announce(message, "polite" | "assertive")` is exported for your own messages.

## Styling and Tailwind

Components are unstyled by default and only emit `anky-ui-*` classes (the diff also ships inline red and green colours unless `unstyled` is set). You have three options:

1. Style the `anky-ui-*` classes in your own CSS.
2. Pass `classNames` to add your own classes per slot.
3. Use the ready-made Tailwind presets: `StyledSelectionPalette`, `StyledInlineDiff`, `selectionPaletteTailwindPreset`, `inlineDiffTailwindPreset`.

Tailwind only generates classes it can see, so add the package to your sources:

```css
/* Tailwind v4 */
@source "../node_modules/@erankushpatil/anky-ui/dist";
```

```js
// Tailwind v3 (tailwind.config.js)
content: ["./src/**/*.{ts,tsx}", "./node_modules/@erankushpatil/anky-ui/dist/**/*.js"];
```

## CLI

Copy components straight into your project and own the code, as with shadcn/ui.

```bash
npx anky-ui add selection-palette
npx anky-ui add inline-diff ghost-input
npx anky-ui add --all
npx anky-ui list
```

Files are written to `src/components/anky/`, or `components/anky/` when the project has no `src` folder. The CLI looks for the nearest `package.json` and detects `tailwind.config.*`, TypeScript and your package manager. Internal imports are rewritten to sit side by side, and `@floating-ui/react` is the only dependency it installs.

| Command / flag | Description |
| --- | --- |
| `add <component...>` | Copy components and the files they import. |
| `list` | Show available components. |
| `-a`, `--all` | Add every component. |
| `-p`, `--path <dir>` | Output directory, relative to the project root. |
| `-o`, `--overwrite` | Replace existing files that differ. Without it, edited files are kept. |
| `--dry-run` | Print what would change without writing or installing. |
| `--no-install` | Print the dependency install command instead of running it. |
| `--cwd <dir>` | Run as if started in another directory. |
| `-h`, `--help`, `-v`, `--version` | Help and version. |

Components: `selection-palette`, `inline-diff`, `ghost-input`, `use-selection-anchor`, `use-optimistic-ai-state`, `diff`, `stream-parser`, `announce`, `stream-providers`, `editor-adapter`, `prosemirror-adapter`, `tiptap-adapter`, `lexical-adapter`, `use-editor-anchor`. Dependencies are added automatically, for example `selection-palette` also copies `use-selection-anchor`.

## Server and Next.js notes

- Components and hooks include the `"use client"` directive. Import them from Client Components in the App Router.
- Rendering is SSR-safe: selection virtual elements, media queries and platform detection are initialised in `useEffect`, so there are no hydration mismatches.
- A minimal streaming route handler:

```ts
// app/api/rewrite/route.ts
export async function POST(req: Request) {
  const { prompt, text } = await req.json();
  const upstream = await callYourModel(prompt, text); // returns a ReadableStream<Uint8Array> of plain text
  return new Response(upstream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
```

## Playground

The repository is a [pnpm](https://pnpm.io) workspace (pnpm 12, Node 18.17+).

```bash
git clone https://github.com/ErAnkushPatil/anky-ui.git
cd anky-ui
pnpm install
pnpm dev:demo
```

The demo shows a 500-word editable article with the palette and inline diff, an email draft with ghost completions, and global undo (`Cmd/Ctrl+Z`) and redo (`Cmd/Ctrl+Shift+Z`). It uses a mock stream by default. Set `VITE_ANKY_ENDPOINT` to a POST endpoint that accepts `{ "prompt": "...", "text": "..." }` to use a real backend. Open `#stress` for the 50 tokens/second streaming stress test.

### Docs site

```bash
pnpm dev:docs
```

The docs site has live demos for the components, state hook, provider streaming recipes (OpenAI, Anthropic, Vercel AI SDK), editor adapters and accessibility announcements. Its **Benchmarks** page measures `computeDiff` speed (5 ms budget at 5,000 characters) and the streaming frame rate into `InlineDiff` at 50, 100 and 200 tokens/second, live in your browser.

## Development

```bash
pnpm install
pnpm verify      # typecheck, test and build every package
pnpm test        # tests only
pnpm typecheck   # typecheck only
pnpm build       # build the library, CLI and apps
```

The workspace root is the publishable `anky-ui` CLI package. `packages/cli` is its private implementation (`@anky/cli`). `packages/core` is published separately as `@erankushpatil/anky-ui`. `pnpm pack` at the root builds the CLI and bundles the component registry.

### Releasing

1. Bump `version` in `package.json` and `packages/core/package.json`, and add an entry to [CHANGELOG.md](./CHANGELOG.md). The CLI copies the library's source, so release both together.
2. Verify, commit, tag and push. `pnpm publish` refuses to run on an unpushed or dirty branch.

   ```bash
   pnpm verify
   git commit -am "Release vX.Y.Z" && git tag -a vX.Y.Z -m "vX.Y.Z" && git push --follow-tags
   ```

3. Publish the library first, then the CLI:

   ```bash
   pnpm --filter @erankushpatil/anky-ui publish
   pnpm publish
   ```

4. Approve the release. npm uses [staged publishing](https://docs.npmjs.com/staged-publishing): the new version stays hidden until a maintainer approves it with 2FA. Run `pnpm stage approve` (it lets you pick the staged versions), or approve them under **Staged Packages** on npmjs.com. Check with `npm view @erankushpatil/anky-ui version`.

The root `devEngines` field requires pnpm, so npm commands fail inside the repository. Run `npm login` and `npm deprecate` from another directory.

## Contributing

Issues and pull requests are welcome at [github.com/ErAnkushPatil/anky-ui](https://github.com/ErAnkushPatil/anky-ui/issues). Run `pnpm verify` before opening a pull request.

## FAQ

**Do I need a specific AI provider?** No. Anky UI only consumes a text stream (raw or SSE). Use any model behind your own endpoint.

**Does it need Tailwind?** No. Tailwind presets are optional, and the CLI copies unstyled components.

**Is it SSR and Next.js safe?** Yes. Client-only browser APIs are touched only inside effects.

**Does it work on touch devices?** Yes. Selection tracking handles `touchend` as well as `mouseup` without double triggers.

**How fast is the diff?** Strings up to 5,000 characters diff in under 5 ms, and a work budget bounds the worst case.

## Keywords

ai ui library, inline ai, ambient ai, copilot ui components, shadcn ai, react inline diff streaming, cursor-like inline prompt react, ghost text autocomplete textarea, floating ai action palette, undo redo ai state react, nextjs generative ui, headless ai primitives, tailwind ai components, radix floating ai toolbar.

## License

[ISC](./LICENSE)
