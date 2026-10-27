import type { ReactNode } from "react";

import { ImageModelSelect } from "@botsdk/ui/models";
import { ConnectionsSection } from "../../plugins/mcp/ui/index";
import {
  CredentialsSections,
  KeySettingsPage,
  type LinkedCredentialsHost,
} from "@botsdk/ui/models/key-settings";

/** The Keys page as the Host composes it (`apps/web` keys route): Provider keys and Tool credentials, Connections and the Image Model. */
export function HostKeysPage({
  linkedCredentials,
}: {
  linkedCredentials?: LinkedCredentialsHost;
}): ReactNode {
  return (
    <KeySettingsPage>
      <CredentialsSections linkedCredentials={linkedCredentials} />
      <ConnectionsSection />
      <ImageModelSelect />
    </KeySettingsPage>
  );
}
