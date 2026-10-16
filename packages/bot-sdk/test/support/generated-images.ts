import { generatedImage } from "../../core/server/db/schema";
import { storedParts } from "../../core/shared/message-parts";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { insertMessage } from "./conversations";
import { getTestDb } from "./test-database";
import type { TestUser } from "./users";
import { fakePngBase64 } from "../../plugins/models/server/fake-image-adapter";
import type { TestDeps } from "./deps";

type ImageOptions = { prompt?: string; parentId?: string | null; active?: boolean };

/**
 * Stores a finished Generated image for `user` as a reply of `conversationId`: its Message (whose
 * parts name the image and its prompt), its `generated_image` row and its bytes under
 * `generated-image/<id>` in the test's blob store (spec #278). Returns the image's id.
 */
export async function insertGeneratedImage(
  deps: TestDeps,
  user: TestUser,
  conversationId: string,
  { prompt = "a red bicycle", parentId = null, active = false }: ImageOptions = {},
) {
  const id = uuidv7();
  const reply = await insertMessage({
    conversationId,
    parentId,
    active,
    role: "assistant",
    text: "",
    parts: storedParts([
      {
        type: "generated_image",
        toolCallId: `call-${id}`,
        prompt,
        aspectRatio: "square",
        state: "done",
        imageId: id,
      },
    ]),
  });
  const bytes = new Uint8Array(Buffer.from(fakePngBase64, "base64"));
  await getTestDb().insert(generatedImage).values({
    id,
    userId: user.id,
    messageId: reply.id,
    mediaType: "image/png",
    width: 1,
    height: 1,
    size: bytes.byteLength,
    model: "openai:gpt-image-1-mini",
    createdAt: new Date(),
  });
  await deps.blobStore.put(`generated-image/${id}`, bytes, { contentType: "image/png" });
  return id;
}
