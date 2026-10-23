// The Images eval's cases (spec #801, ticket #809): five cases.
//
//   generate-and-send  the user asks for a picture; the Bot makes it and sends it in the same Turn
//   no-image           the user asks something else; the Bot does not draw
//   edit               "change that image": the Bot edits the earlier file instead of starting over
//
// Each case also has two scripts for the dry run (`--fake`): `good`, what a sound Bot does, which
// must score a pass, and `broken`, what a Bot under a deliberately broken prompt does, which must
// score a fail (`--fake --broken`). A case is trusted once its `broken` script has been seen to fail.

import type { HistoryExchange } from "../turn/cases";
import type { Expect } from "./score";

/** One scripted tool call; a script's last call ends the Turn. */
export type Step = { name: string; input: Record<string, unknown> };

export type ImagesCase = {
  id: string;
  summary: string;
  history: HistoryExchange[];
  /** An image on the Bot's Computer before the Turn, by its path under the Bot's folder. */
  seedImage?: string;
  message: string;
  expect: Expect;
  good: Step[];
  broken: Step[];
};

const send = (text: string, extra: Record<string, unknown> = {}): Step => ({
  name: "send_to_user",
  input: { text, endTurn: true, ...extra },
});
/** `generate_image` is a deferred tool, so the Bot calls it through `run_tool`. */
const draw = (args: Record<string, unknown>): Step => ({
  name: "run_tool",
  input: { name: "generate_image", args },
});

/** The path the fake image adapter's file will not have: the call is what is scored. */
const made = "images/new.png";

const generate = (id: string, message: string, prompt: string): ImagesCase => ({
  id,
  summary: "Asked for a picture, the Bot makes it and sends it in the same Turn.",
  history: [],
  message,
  expect: { kind: "generate-and-send" },
  good: [draw({ prompt }), send("Here it is.", { files: [made] })],
  // A broken prompt claims an image it never made.
  broken: [send("I've drawn it for you!")],
});

const answer = (id: string, message: string, reply: string): ImagesCase => ({
  id,
  summary: "Asked a question, the Bot answers in a Message and makes no image.",
  history: [],
  message,
  expect: { kind: "no-image" },
  good: [send(reply)],
  broken: [draw({ prompt: message }), send("Here is a picture.", { files: [made] })],
});

export const imagesCases: ImagesCase[] = [
  generate(
    "generate-bicycle",
    "Draw me a red bicycle leaning on a wall.",
    "a red bicycle leaning on a wall",
  ),
  generate(
    "generate-logo",
    "Make a logo for my bakery, Wheatsheaf, and send it to me.",
    "a logo for a bakery called Wheatsheaf",
  ),
  answer(
    "no-image-formats",
    "What's the difference between PNG and JPEG?",
    "PNG is lossless and supports transparency; JPEG is lossy and smaller for photos.",
  ),
  answer(
    "no-image-describe",
    "Describe what a lighthouse looks like, in two sentences.",
    "A lighthouse is a tall tower with a bright lamp at the top. It stands on a coast to guide ships.",
  ),
  {
    id: "edit-earlier",
    summary: "Asked to change the image it made, the Bot edits that file instead of starting over.",
    history: [{ user: "Draw a lighthouse.", bot: ["Here it is: images/lighthouse.png"] }],
    seedImage: "images/lighthouse.png",
    message: "Change that image so it is night time.",
    expect: { kind: "edit", path: "images/lighthouse.png" },
    good: [
      draw({ prompt: "the lighthouse at night", editPaths: ["images/lighthouse.png"] }),
      send("Done.", { files: [made] }),
    ],
    broken: [draw({ prompt: "a lighthouse at night" }), send("Done.", { files: [made] })],
  },
];
