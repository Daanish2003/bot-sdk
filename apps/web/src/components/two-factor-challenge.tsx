import { Button } from "@ai-chat/ui/components/button";
import { Checkbox } from "@ai-chat/ui/components/checkbox";
import { Input } from "@ai-chat/ui/components/input";
import { Label } from "@ai-chat/ui/components/label";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

/**
 * The second step of a sign-in whose password was right: a 6-digit code from the authenticator, or
 * a backup code. The challenge cookie from the password step makes this the whole sign-in.
 */
export function TwoFactorChallenge() {
  const navigate = useNavigate();
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);

  const verify = useMutation({
    mutationFn: async () => {
      const { error } = useBackupCode
        ? await authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice })
        : await authClient.twoFactor.verifyTotp({ code: code.trim(), trustDevice });
      if (error) throw new Error(error.message ?? "That code didn't work");
    },
    onSuccess: () => {
      toast.success("Sign in successful");
      navigate({ to: "/c" });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <main className="mx-auto mt-10 w-full max-w-md p-6">
      <h1 className="mb-6 text-center text-3xl font-bold">Two-factor authentication</h1>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          verify.mutate();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="two-factor-code">
            {useBackupCode ? "Backup code" : "Authentication code"}
          </Label>
          <Input
            id="two-factor-code"
            name="code"
            autoComplete="one-time-code"
            inputMode={useBackupCode ? "text" : "numeric"}
            maxLength={useBackupCode ? 64 : 6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={() => {
              setUseBackupCode((current) => !current);
              setCode("");
            }}
          >
            {useBackupCode ? "Use an authentication code instead" : "Use a backup code instead"}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="two-factor-trust-device"
            checked={trustDevice}
            onCheckedChange={(checked) => setTrustDevice(checked === true)}
          />
          <Label htmlFor="two-factor-trust-device">Trust this device for 30 days</Label>
        </div>
        <Button type="submit" className="w-full" disabled={verify.isPending || code.trim() === ""}>
          {verify.isPending ? "Verifying..." : "Verify"}
        </Button>
      </form>
    </main>
  );
}
