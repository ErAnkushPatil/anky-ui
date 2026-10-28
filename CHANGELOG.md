# Changelog

All notable changes to `@erankushpatil/anky-ui` and the `anky-ui` CLI are documented here. Both packages are released together with the same version number. This project follows [Semantic Versioning](https://semver.org).

## [0.1.1] - 2026-10-28

Documentation only. No code changes.

- Add use cases to both READMEs, so they also show on the npm pages.
- Add FAQ entries on using Anky UI with the Vercel AI SDK and alongside chat UIs.
- Document the release process, including npm staged-publishing approval.

## [0.1.0] - 2026-10-28

First public release.

### `@erankushpatil/anky-ui`

- `SelectionPalette` and `StyledSelectionPalette`: floating AI action bar anchored to the text selection.
- `InlineDiff` and `StyledInlineDiff`: live word or character diff of a streaming rewrite, with Accept and Reject.
- `GhostInput`: textarea with Copilot-style ghost text suggestions.
- `useOptimisticAIState`: optimistic streaming state with rollback and undo/redo.
- `useSelectionAnchor`, `computeDiff`, `streamTextReader` and `announce` utilities.
- `providerTextReader` and `providerTextStream` for OpenAI, Anthropic and Vercel AI SDK streams.
- Tiptap, ProseMirror and Lexical editor adapters with `useEditorAnchor`.
- ESM and CommonJS builds with TypeScript types. Supports React 18 and 19.

### `anky-ui` CLI

- `add` and `list` commands copy components and their dependencies into your project.

[0.1.1]: https://github.com/ErAnkushPatil/anky-ui/releases/tag/v0.1.1
[0.1.0]: https://github.com/ErAnkushPatil/anky-ui/releases/tag/v0.1.0
