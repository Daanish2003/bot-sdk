import { describe, expect, it, vi } from "vitest";

import { imageBytes } from "../../../../core/server/chat/generate-image-tool";
import { imageInfo } from "../../../../core/server/chat/image-info";
import { fakePngBase64 } from "../../../../core/server/chat/fake-image-adapter";

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
