import { describe, expect, it } from "vitest";

import { chatgptPlanFetch } from "../../../plugins/models/server/internal";

function planAnswers(status: number, body: unknown) {
  return chatgptPlanFetch(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("chatgptPlanFetch on a rejected call", () => {
  it("keeps OpenAI's message on a 429 but gives it a plan code, so it is not the generic rate-limit text", async () => {
    const plan = planAnswers(429, {
      error: { message: "You've hit your usage limit.", type: "usage_limit_reached", code: "429" },
    });

    const response = await plan("https://chatgpt.test/responses", { method: "POST", body: "{}" });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        message: "You've hit your usage limit.",
        type: "usage_limit_reached",
        code: "chatgpt_plan_rate_limited",
      },
    });
  });

  it("gives a 403 a plan code too, so it is not read as a rejected API key", async () => {
    const plan = planAnswers(403, {
      error: { message: "Your plan does not include this Model.", type: "forbidden", code: "403" },
    });

    const response = await plan("https://chatgpt.test/responses", { method: "POST", body: "{}" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        message: "Your plan does not include this Model.",
        type: "forbidden",
        code: "chatgpt_plan_forbidden",
      },
    });
  });

  it("leaves a 429 whose body isn't JSON as it is", async () => {
    const plan = chatgptPlanFetch(async () => new Response("slow down", { status: 429 }));

    const response = await plan("https://chatgpt.test/responses", { method: "POST", body: "{}" });

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("slow down");
  });
});
