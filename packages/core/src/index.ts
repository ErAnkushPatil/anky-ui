export {
  ProviderStreamError,
  providerTextReader,
  providerTextStream,
  openAIEventText,
  anthropicEventText,
  aiSdkEventText,
  type StreamProvider,
} from "./stream/providers";
export { announce, type AnnouncePoliteness } from "./a11y/announce";
export { createProseMirrorAdapter } from "./adapters/prosemirror";
export type {
  ProseMirrorViewLike,
  ProseMirrorSelection,
  ProseMirrorAdapterOptions,
  ProseMirrorTransactionLike,
} from "./adapters/prosemirror";
export { createTiptapAdapter, type TiptapEditorLike } from "./adapters/tiptap";
export {
  createLexicalAdapter,
  type LexicalEditorLike,
  type LexicalHelpers,
  type LexicalSelection,
  type LexicalRangeSelectionLike,
} from "./adapters/lexical";
export { useEditorAnchor, type UseEditorAnchorOptions, type UseEditorAnchorResult } from "./adapters/useEditorAnchor";
export type { EditorAdapter, EditorSelection, ClientRectLike } from "./adapters/editorAdapter";
export {
  streamTextReader,
  type StreamFraming,
  type StreamTextReaderOptions,
  type StreamTextSource,
} from "./stream/parser";
export {
  computeDiff,
  DEFAULT_DIFF_MAX_COST,
  type DiffSegment,
  type DiffMode,
  type DiffOptions,
} from "./diff/myers";
export {
  useSelectionAnchor,
  captureSelectionSnapshot,
  resolveSelectionSnapshot,
  SELECTION_DEBOUNCE_MS,
  type UseSelectionAnchorOptions,
  type UseSelectionAnchorResult,
  type SelectionVirtualElement,
  type SelectionSnapshot,
} from "./dom/useSelectionAnchor";
export {
  SelectionPalette,
  StyledSelectionPalette,
  DEFAULT_PALETTE_ACTIONS,
  selectionPaletteTailwindPreset,
  type SelectionPaletteProps,
  type SelectionPaletteAction,
  type SelectionPaletteClassNames,
} from "./components/SelectionPalette";
export {
  GhostInput,
  DEFAULT_GHOST_DEBOUNCE_MS,
  type GhostInputProps,
  type GhostInputHandle,
} from "./components/GhostInput";
export {
  InlineDiff,
  StyledInlineDiff,
  inlineDiffTailwindPreset,
  type InlineDiffProps,
  type InlineDiffClassNames,
} from "./components/InlineDiff";
export {
  useOptimisticAIState,
  OptimisticAIStore,
  StreamResponseError,
  HISTORY_LIMIT,
  type UseOptimisticAIStateOptions,
  type UseOptimisticAIStateResult,
  type OptimisticAISnapshot,
  type OptimisticAIActions,
  type OptimisticAIHistory,
  type StreamSource,
  type StreamTransform,
  type MutateWithStreamOptions,
  type MutationOutcome,
  type StreamAbortCause,
} from "./hooks/useOptimisticAIState";
