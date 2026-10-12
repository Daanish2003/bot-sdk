import {
  reasoningChoiceLabel,
  reasoningChoices,
  type ReasoningChoice,
  type ReasoningSupport,
} from "../../core/shared/chat/models";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useNewConversationModel } from "../../core/client/react/new-conversation-model";
import { useNewConversationEffort } from "../../core/client/react/new-conversation-effort";
import { useOrpc } from "../../core/client/react/provider";

/** The select's value for "the Model's default", which a Conversation stores as `null`. */
const defaultValue = "default";

/**
 * The reasoning effort control beside the Model picker: the Model's default, then only the choices
 * the Model offers. Hidden for a Model with no choices (or no Model yet).
 */
export function ReasoningEffortSelect({
  model,
  value,
  onChange,
}: {
  model: { provider: string; reasoning: ReasoningSupport } | undefined;
  /** The stored choice; `null` is the Model's default. */
  value: ReasoningChoice | null;
  onChange: (effort: ReasoningChoice | null) => void;
}) {
  if (!model) return null;
  const choices = reasoningChoices(model);
  if (choices.length === 0) return null;
  // A stored choice this Model doesn't offer shows as the default; it stays stored, so switching back restores it.
  const selected = value !== null && choices.includes(value) ? value : null;
  const items = [
    { value: defaultValue, label: reasoningChoiceLabel(null) },
    ...choices.map((choice) => ({ value: choice, label: reasoningChoiceLabel(choice) })),
  ];

  return (
    <Select
      items={items}
      value={selected ?? defaultValue}
      onValueChange={(next) => onChange(next === defaultValue ? null : (next as ReasoningChoice))}
    >
      <SelectTrigger aria-label="Reasoning effort" size="sm" className="min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The effort control of the open Conversation; changing it stores the choice on the Conversation. */
export function ConversationReasoningEffort({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const conversation = useQuery(orpc.conversation.get.queryOptions({ input: { id } }));
  const models = useQuery(orpc.models.list.queryOptions());
  const getKey = orpc.conversation.get.queryKey({ input: { id } });
  const setEffort = useMutation(
    orpc.conversation.setReasoningEffort.mutationOptions({
      onMutate: ({ reasoningEffort }) => {
        const previous = conversation.data?.reasoningEffort ?? null;
        queryClient.setQueryData(getKey, (old) => old && { ...old, reasoningEffort });
        return { previous };
      },
      onError: (error, _, context) => {
        queryClient.setQueryData(
          getKey,
          (old) => old && { ...old, reasoningEffort: context?.previous ?? null },
        );
        toast.error(error.message);
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: getKey }),
    }),
  );
  const model = models.data?.models.find((entry) => entry.id === conversation.data?.model);

  return (
    <ReasoningEffortSelect
      model={model}
      value={conversation.data?.reasoningEffort ?? null}
      onChange={(reasoningEffort) => setEffort.mutate({ id, reasoningEffort })}
    />
  );
}

/** The effort control of a new Conversation, kept until the Conversation is created with it. */
export function NewConversationReasoningEffort() {
  const orpc = useOrpc();
  const models = useQuery(orpc.models.list.queryOptions());
  const { model } = useNewConversationModel();
  const { effort, setEffort } = useNewConversationEffort();

  return (
    <ReasoningEffortSelect
      model={models.data?.models.find((entry) => entry.id === model)}
      value={effort}
      onChange={setEffort}
    />
  );
}
