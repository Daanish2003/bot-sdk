import { Button } from "@/components/ui/button";
import {
  PromptInput,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-kit/prompt-input";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * The docked composer: Enter sends, Shift+Enter starts a new line. While a reply streams, sending
 * is disabled and Send becomes Stop.
 */
export function Composer({
  onSend,
  onStop,
  streaming = false,
  disabled = false,
  children,
  attachments,
  attachmentsPending = false,
  placeholder = "Message (Shift+Enter for a new line)",
  value: controlledValue,
  onValueChange,
  refusal,
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  /** A reply is streaming in this Conversation. */
  streaming?: boolean;
  /** When sending isn't possible. */
  disabled?: boolean;
  /** Extra controls on the left of the actions row. */
  children?: ReactNode;
  /** The attachment chips, above the text. */
  attachments?: ReactNode;
  /** An attachment is still uploading (or failed), so sending waits. */
  attachmentsPending?: boolean;
  /** Shown instead of the default hint, for example while a call waits for Approval. */
  placeholder?: string;
  /** The text in the box. Leave it out and the composer keeps its own; pass it to restore a draft. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Why the last Message was refused (#267), shown above the box. */
  refusal?: string | null;
}) {
  const [ownValue, setOwnValue] = useState("");
  const value = controlledValue ?? ownValue;
  const setValue = onValueChange ?? setOwnValue;
  const canSend = !disabled && !streaming && !attachmentsPending && value.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
  };

  return (
    <>
      {refusal && (
        <p role="alert" className="text-xs text-destructive">
          {refusal}
        </p>
      )}
      <PromptInput
        value={value}
        onValueChange={setValue}
        onSubmit={submit}
        isLoading={disabled || streaming}
        className="bg-card"
      >
        {attachments}
        <PromptInputTextarea
          placeholder={placeholder}
          className="text-sm text-foreground"
          aria-label="Message"
        />
        <PromptInputActions className="justify-between px-1 pt-1">
          <div className="flex items-center gap-1">{children}</div>
          <Button
            size="icon"
            className="rounded-full"
            disabled={streaming ? !onStop : !canSend}
            onClick={streaming ? onStop : submit}
            aria-label={streaming ? "Stop" : "Send"}
          >
            {streaming ? <SquareIcon className="fill-current" /> : <ArrowUpIcon />}
          </Button>
        </PromptInputActions>
      </PromptInput>
    </>
  );
}
