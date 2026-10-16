import { afterEach, describe, expect, it, vi } from "vitest";

import { ModeratedError } from "../../../core/client/moderation";
import { runFetch } from "../../../core/client/rate-limit";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stubs the network with one response, as the Run endpoint would answer it. */
function answerWith(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

describe("a Message the Host refuses", () => {
  it("fails the send with the Host's reason, which the composer shows", async () => {
    answerWith(
      Response.json(
        { message: "Off-policy request", code: "moderated", reason: "Off-policy request" },
        { status: 422 },
      ),
    );

    const error = await runFetch("http://localhost/api/chat/run").catch((caught) => caught);

    expect(error).toBeInstanceOf(ModeratedError);
    expect(error.message).toBe("Off-policy request");
  });

  it("leaves every other response to the send as it was", async () => {
    answerWith(new Response("ok", { status: 200 }));

    const response = await runFetch("http://localhost/api/chat/run");

    expect(response.status).toBe(200);
  });
});
