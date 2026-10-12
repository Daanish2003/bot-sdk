import { describe, expect, it } from "vitest";

import { resolveCredentials, resolvedServices } from "../../../../core/server/credentials/resolve";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { createTestDeps } from "../../../support/deps";
import { insertUser } from "../../../support/users";

describe("credential resolution", () => {
  it("answers with the user's own credentials for the service", async () => {
    const user = await insertUser();
    const deps = createTestDeps();
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "sk-proj-abcd" },
      hint: "…abcd",
      verified: true,
    });

    await expect(resolveCredentials(deps, user.id, "openai")).resolves.toEqual({
      apiKey: "sk-proj-abcd",
    });
  });

  it("answers nothing for a service the user has no credentials for", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const deps = createTestDeps();
    await saveCredentials(deps, other.id, {
      service: "openai",
      fields: { apiKey: "sk-proj-abcd" },
      hint: "…abcd",
      verified: true,
    });

    await expect(resolveCredentials(deps, user.id, "openai")).resolves.toBeNull();
  });

  it("lists the services the user has credentials for", async () => {
    const user = await insertUser();
    const deps = createTestDeps();
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-api03-secret-good-1234" },
      hint: "…1234",
      verified: true,
    });

    await expect(resolvedServices(deps, user.id)).resolves.toEqual(["anthropic"]);
  });
});
