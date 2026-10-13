import { generatedImage } from "../../core/server/db/schema/generated-image";
import { storedParts } from "../../core/shared/message-parts";
import type { AppDeps } from "../../core/server/deps";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { insertMessage } from "./conversations";
import { getTestDb } from "./test-database";
import type { TestUser } from "./users";
import { fakePngBase64 } from "../../core/server/chat/fake-image-adapter";

/**
 * Stores a finished Generated image for `user` as a reply of `conversationId`: its Message (whose
 * parts name the image and its prompt), its `generated_image` row and its bytes under
 * `generated-image/<id>` in the test's blob store (spec #278). Returns the image's id.
 */
export async function insertGeneratedImage(
  deps: AppDeps,
  user: TestUser,
  conversationId: string,
  { prompt = "a red bicycle", parentId = null }: { prompt?: string; parentId?: string | null } = {},
) {
  const id = uuidv7();
  const reply = await insertMessage({
    conversationId,
    parentId,
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
