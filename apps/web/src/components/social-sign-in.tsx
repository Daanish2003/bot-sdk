import { Button } from "@ai-chat/ui/components/button";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

const providers = [
  { id: "github", label: "Continue with GitHub" },
  { id: "google", label: "Continue with Google" },
] as const;

export default function SocialSignIn() {
  return (
    <div className="mx-auto mt-6 w-full max-w-md space-y-3 px-6">
      {providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          className="w-full"
          onClick={async () => {
            // Better Auth answers with the provider's authorize URL and the browser follows it.
            const { error } = await authClient.signIn.social({
              provider: provider.id,
              callbackURL: "/c",
            });
            if (error) toast.error(error.message || "Could not start sign-in");
          }}
        >
          {provider.label}
        </Button>
      ))}
    </div>
  );
}
