import { project } from "../../../core/server/db/schema/chat";
import { getTestDb } from "../../support/test-database";

import { describe, expect, it } from "vitest";

import { newConversationModel } from "../../../core/client/models";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { saveCredentials } from "../../../core/server/credentials/store";
import { createTestDeps } from "../../support/deps";
import { createTestChat } from "../../support/sdk";
import { insertUser } from "../../support/users";

/**
 * What the new-Conversation page asks the handler for, and what it picks from the answers: the
 * test drives the headless client against the handler, as a Host does.
 */
async function startingModelFor({
  picked,
  projectDefault,
}: {
  picked?: string;
  projectDefault?: string | null;
}) {
  const deps = createTestDeps();
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const chat = createTestChat({ user, deps });
  const id = uuidv7();
  await getTestDb()
    .insert(project)
    .values({ id, userId: user.id, name: "Work", defaultModel: projectDefault ?? null });

  const [models, { defaultModel }] = await Promise.all([
    chat.rpc.models.list({}),
    chat.rpc.project.get({ id }),
  ]);
  return newConversationModel({
    picked,
    projectModel: defaultModel,
    available: models.models.map((model) => model.id),
    listDefault: models.defaultModel,
  });
}

describe("the new-Conversation Model", () => {
  it("is the Model the user picked, over the Project's default", async () => {
    await expect(
      startingModelFor({ picked: "openai:gpt-5.4-mini", projectDefault: "openai:gpt-5.6" }),
    ).resolves.toBe("openai:gpt-5.4-mini");
  });

  it("is the Project's default when it is available and nothing is picked", async () => {
    const listDefault = "openai:gpt-5.6";

    const model = await startingModelFor({ projectDefault: "openai:gpt-5.4-mini" });

    expect(model).toBe("openai:gpt-5.4-mini");
    expect(model).not.toBe(listDefault);
  });

  it("is the models.list default when the Project has no default Model", async () => {
    const model = await startingModelFor({ projectDefault: null });

    expect(model).toBe("openai:gpt-5.6");
  });

  it("is the models.list default when the Project's Model is no longer available", async () => {
    // The user has no Anthropic credentials, so this Model isn't in models.list.
    const model = await startingModelFor({ projectDefault: "anthropic:claude-sonnet-5-5" });

    expect(model).toBe("openai:gpt-5.6");
  });
});
