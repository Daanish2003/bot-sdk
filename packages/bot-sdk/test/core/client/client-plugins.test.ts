import { describe, expect, it } from "vitest";

import { createBotSdkClient } from "../../../core/client/chat-client";
import { botClient } from "../../../plugins/bot/client/index";
import { memoryClient } from "../../../plugins/memory/client/index";
import { modelsClient } from "../../../plugins/models/client/index";

describe("the client's plugins", () => {
  it("lists the ids of the plugins it was created with, in order", () => {
    const client = createBotSdkClient({
      baseUrl: "http://localhost/api/chat",
      plugins: [modelsClient(), botClient(), memoryClient()],
    });

    expect(client.plugins).toEqual(["models", "bot", "memory"]);
  });
});
