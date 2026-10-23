import type { ReactNode } from "react";

import { useChatAdapter } from "../../core/client/react/provider";
import {
  ArchivedConversationsSection,
  BackgroundModelSelect,
  ConnectionsSection,
  DeleteAllConversationsSection,
  ImageModelSelect,
  InstructionsField,
  SavedPromptsSection,
  SharedLinksSection,
  YourDataSection,
} from "../../plugins/assistant/ui/index";
import { MemorySection } from "../../plugins/memory/ui/memory-section";
import {
  CredentialsSections,
  KeySettingsPage,
  type LinkedCredentialsHost,
} from "../../plugins/models/ui/key-settings";

/** The Keys page as the example Host composes it (`apps/web` keys route): models sections first. */
export function HostKeysPage({
  linkedCredentials,
}: {
  linkedCredentials?: LinkedCredentialsHost;
}): ReactNode {
  const { plugins } = useChatAdapter();
  return (
    <KeySettingsPage>
      <CredentialsSections linkedCredentials={linkedCredentials} />
      <ConnectionsSection />
      <SharedLinksSection />
      <ArchivedConversationsSection />
      <InstructionsField />
      {plugins.includes("memory") && <MemorySection />}
      <SavedPromptsSection />
      <BackgroundModelSelect />
      <ImageModelSelect />
      <YourDataSection />
      <DeleteAllConversationsSection />
    </KeySettingsPage>
  );
}
