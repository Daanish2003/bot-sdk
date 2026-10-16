import { type StoredPart, storedParts } from "../../../../plugins/assistant/shared/message-parts";
import { type MessagePart } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import {
  cancelRunningCalls,
  createPartsBuilder,
  parseStoredParts,
  toModelMessages,
  toUIParts,
} from "../../../../plugins/assistant/shared/chat/parts";
import { generatedImageOf } from "../../../../plugins/assistant/shared/chat/generated-image";

const image = (
  fields: Partial<Extract<StoredPart, { type: "generated_image" }>> = {},
): StoredPart => ({
  type: "generated_image",
  toolCallId: "call-1",
  prompt: "a red bicycle",
  aspectRatio: "square",
  state: "done",
  imageId: "image-1",
  ...fields,
});

const text = (value: string): StoredPart => ({ type: "text", text: value });

describe("generated images in stored parts", () => {
  it("reads a schemaVersion 3 row with a generated image", () => {
    const json = storedParts([text("Here."), image()]);

    expect(parseStoredParts(json)).toEqual(json);
  });

  it("still reads schemaVersion 1 and 2 rows", () => {
    const v1 = { schemaVersion: 1, parts: [text("Hi")] };
    const v2 = { schemaVersion: 2, parts: [text("Hi")] };

    expect(parseStoredParts(v1)).toEqual(v1);
    expect(parseStoredParts(v2)).toEqual(v2);
  });

  it("refuses a generated image with an unknown error reason or aspect ratio", () => {
    expect(() =>
      parseStoredParts(
        storedParts([image({ state: "error", errorReason: "exploded" as "failed" })]),
      ),
    ).toThrow();
    expect(() =>
      parseStoredParts(storedParts([image({ aspectRatio: "tall" as "square" })])),
    ).toThrow();
  });
});

describe("generated images from a stream", () => {
  it("adds a running image in stream order and finishes it with its image id", () => {
    const builder = createPartsBuilder();
    builder.startGeneratedImage("call-1", "a red bicycle", "square");
    expect(builder.parts().parts).toEqual([image({ state: "running", imageId: undefined })]);

    builder.finishGeneratedImage("call-1", { imageId: "image-1" });

    expect(builder.parts().parts).toEqual([image()]);
  });

  it("finishes a failed image with its reason", () => {
    const builder = createPartsBuilder();
    builder.startGeneratedImage("call-1", "a red bicycle", "landscape");

    builder.finishGeneratedImage("call-1", { errorReason: "refused" });

    expect(builder.parts().parts).toEqual([
      image({
        aspectRatio: "landscape",
        state: "error",
        imageId: undefined,
        errorReason: "refused",
      }),
    ]);
  });

  it("closes a running image as cancelled when the reply ends", () => {
    const builder = createPartsBuilder();
    builder.startGeneratedImage("call-1", "a red bicycle", "square");

    expect(cancelRunningCalls(builder.parts()).parts).toEqual([
      image({ state: "cancelled", imageId: undefined }),
    ]);
  });

  it("cancelRunningCalls closes a stored running image too", () => {
    expect(
      cancelRunningCalls(storedParts([image({ state: "running", imageId: undefined })])).parts,
    ).toEqual([image({ state: "cancelled", imageId: undefined })]);
  });
});

describe("generated images in provider history", () => {
  it("replays a finished image as a generate_image call and its text-only result when offered", () => {
    expect(
      toModelMessages([{ role: "assistant", parts: storedParts([text("Done."), image()]) }], {
        generateImage: true,
      }),
    ).toEqual([
      {
        role: "assistant",
        content: "Done.",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "generate_image",
              arguments: JSON.stringify({ prompt: "a red bicycle", aspectRatio: "square" }),
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({
          imageId: "image-1",
          prompt: "a red bicycle",
          aspectRatio: "square",
        }),
      },
    ]);
  });

  it("replays a finished image as text when the tool is not offered", () => {
    expect(toModelMessages([{ role: "assistant", parts: storedParts([image()]) }], {})).toEqual([
      { role: "assistant", content: '[Generated an image: "a red bicycle"]' },
    ]);
  });
});

describe("generated images in the UI parts", () => {
  it("maps a done image to a generate_image tool call with its image id", () => {
    const [part] = toUIParts(storedParts([image()]));

    expect(part).toMatchObject({ type: "tool-call", name: "generate_image", id: "call-1" });
    expect(generatedImageOf(part as MessagePart)).toEqual(image());
  });

  it("maps a failed image to its reason, and a cancelled one to cancelled", () => {
    const [failed, cancelled] = toUIParts(
      storedParts([
        image({ state: "error", imageId: undefined, errorReason: "limit_reached" }),
        image({ toolCallId: "call-2", state: "cancelled", imageId: undefined }),
      ]),
    );

    expect(generatedImageOf(failed as MessagePart)).toMatchObject({
      state: "error",
      errorReason: "limit_reached",
    });
    expect(generatedImageOf(cancelled as MessagePart)).toMatchObject({ state: "cancelled" });
  });
});
