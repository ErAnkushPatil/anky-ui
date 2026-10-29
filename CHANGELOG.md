# Changelog

All notable changes to `@erankushpatil/anky-ui` and the `anky-ui` CLI are documented here. Both packages are released together with the same version number. This project follows [Semantic Versioning](https://semver.org).

## [1.1.0] - 2026-10-29

### Fixed

- **Next.js Server Components:** the published bundle now starts with `"use client"`. In 1.0.0 the bundler dropped the directive, so rendering a component from a Server Component failed with `createContext is not a function`.
- **`streamFromEndpoint` dropped headers** passed as a `Headers` instance or tuple array (for example an `Authorization` token). All `HeadersInit` shapes are now kept, and the JSON and event-stream defaults apply only when you don't set those headers yourself.
- **`providerTextReader(..., "ai-sdk")`** could lose tokens from a v4 data stream when a network chunk split a record right before a `{`. The framing is now decided once per stream.
- **CLI on Windows:** dependency installs now quote arguments for `cmd.exe`, which treats `^` as an escape character, so `@floating-ui/react@^0.27.0` keeps its version range.

### Added

- `@erankushpatil/anky-ui/utils`: a React-free entry without `"use client"`, for server code such as route handlers. It exports `computeDiff`, `streamTextReader`, `providerTextReader`, `providerTextStream` and `ProviderStreamError`.
- `engines.node` (`>=18.17`) on the library package.
- A Security section in the README, and SECURITY.md for private vulnerability reports.
- CI on GitHub Actions: typecheck, test and build on Node 22 and 24, and a CLI run on Node 18.17.

## [1.0.0] - 2026-10-28

First stable release. The public API is now covered by Semantic Versioning: breaking changes will only ship in a new major version. The code is the same as 0.1.0.

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

[1.1.0]: https://github.com/ErAnkushPatil/anky-ui/releases/tag/v1.1.0
[1.0.0]: https://github.com/ErAnkushPatil/anky-ui/releases/tag/v1.0.0
[0.1.0]: https://github.com/ErAnkushPatil/anky-ui/releases/tag/v0.1.0
