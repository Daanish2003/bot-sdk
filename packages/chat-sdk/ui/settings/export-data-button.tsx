import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";

import { useChatAdapter } from "../../core/client/react/provider";

const exportFailed = "Couldn't export your data";

/** Downloads the signed-in user's export (`exportUrl`) as one JSON file, named by the server. */
export function ExportDataButton() {
  const { exportUrl } = useChatAdapter();
  const [pending, setPending] = useState(false);

  async function download() {
    setPending(true);
    try {
      const response = await fetch(exportUrl);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        toast.error(body?.message ?? exportFailed);
        return;
      }
      const fileName = /filename="([^"]+)"/.exec(
        response.headers.get("Content-Disposition") ?? "",
      )![1]!;
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      // Some browsers cancel the download when the URL is revoked too soon.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error(exportFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={download}>
      {pending ? "Preparing…" : "Export my data"}
    </Button>
  );
}
