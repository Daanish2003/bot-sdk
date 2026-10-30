/*
 * PROTOTYPE for #1054, throwaway, never merge.
 * Plan: three Room UI variants (A group chat, B roster rail, C handoff threads) on stub data, switched by ?variant=.
 */
import { createFileRoute } from "@tanstack/react-router";

import { type RoomVariant, RoomUiPrototype } from "@/components/room-ui-prototype";

export const Route = createFileRoute("/bots/room-prototype")({
  validateSearch: (search: Record<string, unknown>): { variant?: RoomVariant } =>
    search.variant === "A" || search.variant === "B" || search.variant === "C"
      ? { variant: search.variant }
      : {},
  component: RoomPrototypePage,
});

function RoomPrototypePage() {
  const { variant = "A" } = Route.useSearch();
  return <RoomUiPrototype variant={variant} />;
}
