import { oc, type } from "@orpc/contract";
import { z } from "zod";

/*
 * The `representative` feature's contract (spec #1167): the owner's Representatives, their working
 * drafts and their Releases, served under `<basePath>/rpc/representative` and implemented by
 * `sdk.representative`'s methods of the same names. Public interface: the browser client is typed
 * by it, and it changes only with the package's semver.
 */

/**
 * The tools a Representative may have: a code-defined list, so no draft can give one a shell or a
 * new power. Later specs add to it.
 */
export const representativeTools = ["reply", "hand_to_bot"] as const;
export type RepresentativeTool = (typeof representativeTools)[number];

export const maxJobTextLength = 20_000;
export const maxSkills = 50;
export const maxSkillTextLength = 20_000;

/** A Skill copied into a draft: a read-only procedure that grants no permission. */
export const skillCopySchema = z.object({
  name: z.string().trim().min(1).max(100),
  text: z.string().max(maxSkillTextLength),
});

/** What the owner writes: the part of a Release that is theirs to edit. */
export const draftSchema = z.object({
  /** What the Representative is told to do. */
  jobText: z.string().max(maxJobTextLength),
  /** The owner's switches, which code checks; the SDK defines none yet. */
  switches: z.record(z.string().min(1).max(64), z.boolean()),
  skills: z.array(skillCopySchema).max(maxSkills),
  /** Only names from `representativeTools`, each once. */
  tools: z
    .array(z.enum(representativeTools))
    .refine((tools) => new Set(tools).size === tools.length, "A tool is listed once"),
  /** The Model, `"provider:model"`, or null for the Host's default. */
  model: z.string().trim().min(1).max(200).nullable(),
});
export type Draft = z.output<typeof draftSchema>;

/**
 * What a Release pins: the owner's draft, the document snapshot reference (empty until the
 * Knowledge spec) and the test conversations (written by the test spec).
 */
export type ReleaseContent = Draft & { documentSnapshot: null; tests: unknown[] };

export type ReleaseSummary = { id: string; number: number; approvedAt: Date };
export type ReleaseView = ReleaseSummary & { content: ReleaseContent };

export type RepresentativeSummary = {
  id: string;
  name: string;
  /** The Bot it reports to; null reports to the owner. */
  botId: string | null;
  enabled: boolean;
  /** The number of the live Release, or null before the first approval. */
  liveReleaseNumber: number | null;
};

export type RepresentativeView = RepresentativeSummary & {
  draft: Draft;
  liveRelease: ReleaseView | null;
  releases: ReleaseSummary[];
};

export const idInput = z.object({ id: z.uuid() });
export const createInput = z.object({
  name: z.string().trim().min(1).max(100),
  botId: z.uuid().optional(),
});
export const updateDraftInput = z.object({
  id: z.uuid(),
  draft: draftSchema.partial(),
});
export const setEnabledInput = z.object({ id: z.uuid(), enabled: z.boolean() });
export const setBotInput = z.object({ id: z.uuid(), botId: z.uuid() });

export const representativeContract = {
  /** The owner's Representatives, oldest first. */
  list: oc.output(type<RepresentativeSummary[]>()),
  /** One Representative with its draft, live Release and every Release's number. */
  get: oc.input(idInput).output(type<RepresentativeView>()),
  /** Creates a Representative with an empty draft, reporting to one of the owner's Bots or to none. */
  create: oc.input(createInput).output(type<RepresentativeView>()),
  /** Changes fields of the draft. The live Release stays as it is. */
  updateDraft: oc.input(updateDraftInput).output(type<RepresentativeView>()),
  /** Pins the draft as the next numbered Release and makes it live. */
  approve: oc.input(idInput).output(type<ReleaseView>()),
  /** Switches the Representative on or off, with no new Release. */
  setEnabled: oc.input(setEnabledInput).output(type<RepresentativeView>()),
  /** Chooses which of the owner's Bots it reports to; its open Assignments move to that Bot. */
  setBot: oc.input(setBotInput).output(type<RepresentativeView>()),
};

export type RepresentativeContract = typeof representativeContract;
