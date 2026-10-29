import type { ComponentProps, ReactNode } from "react";

import { ChoiceCard } from "./choice-card";
import { ComputerCard } from "./computer-card";
import { FilesCard } from "./files-card";
import { ReviewRequest } from "./review-request";
import { RoutineCard } from "./routine-card";
import { RuleCard } from "./rule-card";
import { SecretCard } from "./secret-card";
import { ShowMeCard } from "./show-me-card";

/**
 * The `bot` UI's default renderer of each Rich control kind it draws (spec #761). The reserved
 * kinds (`draft`, `payment_approval`) have none: they are never rendered.
 */
export const defaultRichControlRenderers = {
  secret: SecretCard,
  computer: ComputerCard,
  demonstration: ShowMeCard,
  files: FilesCard,
  choice: ChoiceCard,
  routine_approval: RoutineCard,
  review_approval: ReviewRequest,
  rule_approval: RuleCard,
};

type Rendered = typeof defaultRichControlRenderers;

/** What a renderer of each kind is given: the same props as its default renderer. */
export type RichControlRendererProps = {
  [Kind in keyof Rendered]: ComponentProps<Rendered[Kind]>;
};

/**
 * A Host's renderers for the kinds it draws itself (spec #761): a kind it gives replaces its default
 * renderer, and the rest keep theirs.
 */
export type RichControlRenderers = {
  [Kind in keyof Rendered]?: (props: RichControlRendererProps[Kind]) => ReactNode;
};
