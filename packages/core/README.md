# @erankushpatil/anky-ui

React AI UI library for inline AI: a floating AI action palette on text selection, a streaming inline diff with accept/reject, Copilot-style ghost text autocomplete, and optimistic AI state with undo/redo. Headless, Tailwind-ready, and compatible with Next.js.

```bash
npm install @erankushpatil/anky-ui
```

Requires React and React DOM 18 or 19. The only runtime dependency is `@floating-ui/react`.

```tsx
"use client";

import { GhostInput, InlineDiff, SelectionPalette, useOptimisticAIState } from "@erankushpatil/anky-ui";
```

## Use cases

Use it when AI should edit or suggest text where the user is already working, instead of in a separate chat window.

- **Docs, notes, wikis and CMS editors:** select text, pick "Shorten" or "Fix grammar", review the diff, accept.
- **Email, support and CRM replies:** ghost-text suggestions as the user types, accepted with Tab.
- **Product descriptions, listings and marketing copy:** rewrite and compare with the original before saving.
- **Rich-text editors:** the same palette and diff inside Tiptap, ProseMirror or Lexical.
- **Text that needs human sign-off:** every AI change is approved explicitly and can be undone.

It is not a chat UI. Use a chat library for a chat window and Anky UI for inline edits; they work side by side. Already on the Vercel AI SDK? Pass its response to `providerTextStream(response, "ai-sdk")` and keep your backend.

## What's included

| Export | Purpose |
| --- | --- |
| `SelectionPalette`, `StyledSelectionPalette` | Floating AI action bar anchored to the text selection, with preset pills and a freeform prompt input. |
| `InlineDiff`, `StyledInlineDiff` | Live word or character diff of a streaming rewrite with Accept (`Cmd/Ctrl+Enter`) and Reject (`Esc`). |
| `GhostInput` | Textarea with debounced ghost text suggestions. `Tab` or `→` accepts, `Esc` dismisses. |
| `useOptimisticAIState` | Optimistic streaming state with snapshot rollback, 20-entry undo/redo, accept and reject. |
| `useSelectionAnchor` | Hook that exposes the selection as a floating-ui virtual element. SSR-safe, touch-aware. |
| `computeDiff` | Zero-dependency Myers diff. `computeDiff(old, new, "word" \| "char")`. |
| `streamTextReader` | Async generator for raw or SSE text streams with `AbortSignal` support. |
| `providerTextReader`, `providerTextStream` | Decode OpenAI, Anthropic and Vercel AI SDK streaming formats into plain text. |
| `createTiptapAdapter`, `createProseMirrorAdapter`, `createLexicalAdapter`, `useEditorAnchor` | Use `SelectionPalette` on rich-text editors through the `anchor` prop. Structurally typed, no editor dependency. |
| `announce` | Shared screen-reader live region used by the components. |

## Example

```tsx
const ai = useOptimisticAIState({ initialState: { original: "", modified: "" } });

<SelectionPalette
  onSelectPrompt={(prompt, text) =>
    ai.mutateWithStream(
      (signal) => fetch("/api/rewrite", { method: "POST", body: JSON.stringify({ prompt, text }), signal }),
      (s, chunk) => ({ original: text, modified: s.modified + chunk }),
    )
  }
/>;

<InlineDiff
  originalText={ai.currentState.original}
  modifiedText={ai.currentState.modified}
  isStreaming={ai.isStreaming}
  onAccept={ai.accept}
  onReject={ai.reject}
/>;
```

## Styling

Components are unstyled and emit `anky-ui-*` classes: `anky-ui-palette-root`, `anky-ui-palette-input`, `anky-ui-palette-action`, `anky-ui-diff-delete`, `anky-ui-diff-insert` and others. Pass `classNames`, write your own CSS, or use the Tailwind presets. For Tailwind v4 add `@source "../node_modules/@erankushpatil/anky-ui/dist";`, and for v3 add `./node_modules/@erankushpatil/anky-ui/dist/**/*.js` to `content`.

Theme the diff with `--anky-ui-diff-{delete,insert}-{bg,fg}` and the ghost text with `--anky-ui-ghost-color`.

## Copy the source instead

```bash
npx anky-ui add selection-palette
npx anky-ui add inline-diff
npx anky-ui add ghost-input
```

## Documentation

The full API reference, props tables, CLI flags and Next.js notes are in the [repository README](https://github.com/ErAnkushPatil/anky-ui#readme).

## License

ISC
