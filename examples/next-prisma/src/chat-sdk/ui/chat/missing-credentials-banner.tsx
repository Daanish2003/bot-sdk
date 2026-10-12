import { KeyRoundIcon } from "lucide-react";

import { useByok } from "../../core/client/react/byok";
import { useChatAdapter } from "../../core/client/react/provider";

/** Above the composer when the selected Model can't be sent to: its Provider has no credentials. */
export function MissingCredentialsBanner({ message }: { message: string }) {
  const { Link } = useChatAdapter();
  const byok = useByok();
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <KeyRoundIcon className="size-3.5 shrink-0" />
      <span>{message}.</span>
      {byok && (
        <Link page={{ to: "keys" }} className="ml-auto underline">
          Key settings
        </Link>
      )}
    </div>
  );
}
