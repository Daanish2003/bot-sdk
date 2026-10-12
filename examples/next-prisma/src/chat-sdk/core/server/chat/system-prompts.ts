import { citationPrompt } from "../../shared/chat/citations";

/**
 * The system prompts of one Run, in the order the Model reads them: the SDK's own (the citation
 * prompt when the reply may read the web, which users can't edit), then the user's Instructions,
 * then the Project's. The more specific level comes last, so it wins where they conflict.
 */
export function systemPromptsFor({
  web,
  instructions,
  projectInstructions,
}: {
  /** Whether the reply offers the Web tools (`web_search`, `fetch_url`). */
  web: boolean;
  instructions: string | null;
  /** The Instructions of the Conversation's Project; null when it has no Project or none. */
  projectInstructions: string | null;
}): string[] {
  return [
    ...(web ? [citationPrompt] : []),
    ...(instructions ? [instructions] : []),
    ...(projectInstructions ? [projectInstructions] : []),
  ];
}
