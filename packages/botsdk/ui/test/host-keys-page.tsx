import type { ReactNode } from "react";

import { ImageModelSelect } from "../src/models";
import { ConnectionsSection } from "../src/mcp";
import {
  CredentialsSections,
  KeySettingsPage,
  type LinkedCredentialsHost,
} from "../src/models/key-settings";

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
