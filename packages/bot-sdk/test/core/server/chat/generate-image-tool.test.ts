import { describe, expect, it, vi } from "vitest";

import type { EditSource } from "../../../../plugins/assistant/server/chat/edit-sources";
import {
  createGenerateImageTool,
  imageBytes,
} from "../../../../plugins/assistant/server/chat/generate-image-tool";
import { imageInfo } from "../../../../plugins/assistant/server/chat/image-info";
import {
  fakeImageAdapter,
  fakePngBase64,
} from "../../../../plugins/models/server/fake-image-adapter";
import type { ImageMeter } from "../../../../plugins/models/server/meter";
import { createToolBudget } from "../../../../plugins/assistant/server/chat/tracked-tool";
import { createPartsBuilder } from "../../../../plugins/assistant/shared/chat/parts";
import {
  imageLimitError,
  imageUnavailableError,
} from "../../../../plugins/assistant/shared/chat/generated-image";

const pngBytes = Buffer.from(fakePngBase64, "base64");

describe("imageBytes", () => {
  it("decodes a b64Json result without a network call", async () => {
    const fetch = vi.fn();

    const bytes = await imageBytes(
      { b64Json: fakePngBase64 },
      fetch as unknown as typeof globalThis.fetch,
    );

    expect(Buffer.from(bytes)).toEqual(pngBytes);
    expect(fetch).not.toHaveBeenCalled();
    expect(imageInfo(bytes)).toEqual({ mediaType: "image/png", width: 1, height: 1 });
  });

  it("downloads a url result, which Providers let expire", async () => {
    const fetch = vi.fn(async () => new Response(pngBytes));

    const bytes = await imageBytes(
      { url: "https://images.example.test/out.png" },
      fetch as unknown as typeof globalThis.fetch,
    );

    expect(fetch).toHaveBeenCalledWith("https://images.example.test/out.png", {});
    expect(Buffer.from(bytes)).toEqual(pngBytes);
    expect(imageInfo(bytes)).toEqual({ mediaType: "image/png", width: 1, height: 1 });
  });
});

/** The tool on a meter that refuses every call, editing up to 2 images found by `sources`. */
function refusedTool(sources: (ids: string[]) => Promise<EditSource[] | undefined>) {
  const parts = createPartsBuilder();
  const meter: ImageMeter = {
    onHost: true,
    mayRun: async () => ({ ok: false, resetsAt: new Date("2026-01-02T00:00:00Z") }),
    record: async () => {},
  };
  const tool = createGenerateImageTool({
    adapter: fakeImageAdapter(),
    meter,
    userId: "user-1",
    model: "openai:gpt-image-1-mini",
    request: () => ({ size: "1024x1024" }) as never,
    messageId: "message-1",
    deps: {} as never,
    fetch: vi.fn() as never,
    timeoutMs: 1000,
    edit: { maxInputImages: 2, sources },
    parts,
    onChange: () => {},
    budget: createToolBudget(0),
  });
  const call = (id: string, editImageIds?: string[]) =>
    tool.execute!({ prompt: "a bicycle", ...(editImageIds && { editImageIds }) }, {
      toolCallId: id,
    } as never);
  return { call };
}

describe("the generate_image tool's Quota check", () => {
  it("comes after the edit's ids are checked and found", async () => {
    const sources = vi.fn(async () => undefined);
    const { call } = refusedTool(sources);

    await expect(call("too-many", ["a", "b", "c"])).resolves.toMatchObject({
      reason: "too_many_images",
    });
    await expect(call("unknown", ["a"])).resolves.toMatchObject({
      error: imageUnavailableError,
    });
    expect(sources).toHaveBeenCalledWith(["a"]);
  });

  it("refuses a call that keeps its image slot, so the Run's fifth is past the cap", async () => {
    const { call } = refusedTool(async () => []);

    for (const id of ["1", "2", "3", "4"]) {
      await expect(call(id)).resolves.toMatchObject({ reason: "quota_exceeded" });
    }
    await expect(call("5")).resolves.toEqual({ error: imageLimitError, reason: "limit_reached" });
  });
});
