// The agent-loop module's entry point (#889): other modules import it only through this file.
export {
  capOutput,
  capText,
  computerOf,
  computerOperationError,
  computerPrompt,
  computerToolDefinitions,
  computerUnavailableError,
  fetchedLineBytes,
  type FileToolOptions,
  interruptedShellError,
  maxFetchedBytes,
  maxTextBytes,
  readScript,
  rebuiltNote,
  sizeScript,
  spillPath,
  spillThreshold,
} from "./computer-tools";
export {
  callUsage,
  type LoopKit,
  type LoopResult,
  midTurnNote,
  runLoop,
  seesImagesOnce,
  summarizeInstruction,
  totalUsage,
} from "./loop";
export {
  canonicalJson,
  firstMessageSection,
  type LoopPromptStart,
  type PreviousCall,
  sha256,
} from "./prompt-hashes";
export { type SearchClient, SearchError } from "./search-client";
export { createTavilyClient } from "./tavily";
export { webSearchTool, webSearchUnavailableError } from "./web-search";
