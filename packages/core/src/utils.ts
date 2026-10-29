// Framework-agnostic utilities, published as `@erankushpatil/anky-ui/utils`. This entry has no
// "use client" directive and no React import, so it is safe in server code such as Next.js route handlers.
export {
  ProviderStreamError,
  providerTextReader,
  providerTextStream,
  openAIEventText,
  anthropicEventText,
  aiSdkEventText,
  type StreamProvider,
} from "./stream/providers";
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
