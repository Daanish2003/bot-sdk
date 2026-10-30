import { z } from "zod";

import { textPartSchema } from "../message-parts";
import { demonstrationCardSchema } from "./demonstration";
import { choiceControlSchema } from "./choice";
import { filesControlSchema } from "./files";
import { handoffSchema } from "./mentions";
import { computerCardSchema } from "./helper";
import { reviewApprovalSchema } from "./review";
import { routineApprovalSchema } from "./routine";
import { ruleApprovalSchema } from "./rule";
import { storedReactionsSchema } from "./reaction";
import { secretRequestSchema } from "./secret";

/**
 * A kind reserved in the catalog and not built yet (spec #761): only its `kind` is fixed, so the
 * fields it gets later don't break the format. Nothing renders it.
 */
const reservedControlSchema = <Kind extends string>(kind: Kind) =>
  z.looseObject({ kind: z.literal(kind) });

/**
 * The Rich control catalog (spec #761, #754): every purpose-built control a Bot's Message can
 * carry, as one union on `kind`. `draft` and `payment_approval` are reserved.
 */
export const richControlSchema = z.discriminatedUnion("kind", [
  secretRequestSchema,
  computerCardSchema,
  demonstrationCardSchema,
  filesControlSchema,
  choiceControlSchema,
  routineApprovalSchema,
  reviewApprovalSchema,
  ruleApprovalSchema,
  reservedControlSchema("draft"),
  reservedControlSchema("payment_approval"),
]);

export type RichControl = z.infer<typeof richControlSchema>;

export type RichControlKind = RichControl["kind"];

/**
 * Whether a control of `kind` is an Approval: the system asking the user, not a bubble the
 * Bot sent (spec #761): none shows it, and it doesn't count as the Bot sending.
 */
export const isApproval = (kind: RichControlKind | undefined) =>
  kind === "routine_approval" || kind === "review_approval" || kind === "rule_approval";

/**
 * The catalog as JSON Schema, for a Host's own app to render it. It can't carry the Zod checks
 * that aren't shapes, such as a Secret's reserved names: `richControlSchema` is the full check.
 */
export const richControlJsonSchema = z.toJSONSchema(richControlSchema);

/** A Message's stored part that holds its Rich control. */
export const controlPartSchema = z.object({
  type: z.literal("control"),
  control: richControlSchema,
});

/**
 * A Bot Message's stored parts, the Bot's own over the core's envelope: its text, then at most one
 * Rich control. Text is what every Channel can show. Beside the parts: the IANA `timeZone` a user's
 * Message was sent from, the Channel besides web it came in or also went out on, an emailed user's
 * Message's subject, which the Bot's emailed reply answers (spec #761), and its emojis. The Channel is
 * `email` or a messaging platform's id (spec #1044).
 */
export const botMessagePartsSchema = z.object({
  schemaVersion: z.literal(1),
  parts: z
    .array(z.union([textPartSchema, controlPartSchema]))
    .refine((parts) => parts.filter((part) => part.type === "control").length <= 1, {
      error: "A Message has at most one Rich control",
    }),
  timeZone: z.string().optional(),
  channel: z.string().optional(),
  subject: z.string().optional(),
  reactions: storedReactionsSchema.optional(),
  /** The Bot marked this Message urgent (spec #1024). */
  urgent: z.literal(true).optional(),
  /** The handoff a Bot's Room Message made (spec #1055). */
  handoff: handoffSchema.optional(),
});

export type BotMessageParts = z.infer<typeof botMessagePartsSchema>;
