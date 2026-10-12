import { buttonVariants } from "@/components/ui/button";
import { KeyRoundIcon } from "lucide-react";

import { useByok } from "../../core/client/react/byok";
import { useChatAdapter } from "../../core/client/react/provider";

/** The empty state for a user without any Provider credentials: nothing can be sent yet. */
export function NoCredentials() {
  const { Link } = useChatAdapter();
  const byok = useByok();
  if (!byok) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="max-w-sm">
          <h1 className="text-base font-medium">No Models yet</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            This app has no Models for you to chat with.
          </p>
        </div>
      </main>
    );
  }
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary">
        <KeyRoundIcon className="size-5" />
      </div>
      <div className="max-w-sm">
        <h1 className="text-base font-medium">Bring your own key to start</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Every reply runs on your own Provider credentials. Add a key for one of the Providers to
          start chatting.
        </p>
      </div>
      <Link page={{ to: "keys" }} className={buttonVariants()}>
        <KeyRoundIcon /> Add Provider credentials
      </Link>
      <p className="text-xs text-muted-foreground">
        Keys are encrypted on the server and never shown again.
      </p>
    </main>
  );
}
