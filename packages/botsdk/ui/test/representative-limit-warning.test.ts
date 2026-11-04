// @vitest-environment jsdom
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { LimitWarning } from "../src/representative/limit-warning";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

/** A stand-in for `models.readQuota`, which says when the warning has had its answer. */
function show(usedPercent: number | null) {
  let read = false;
  const handler = new RPCHandler({
    models: {
      readQuota: os.handler(() => {
        read = true;
        return usedPercent === null
          ? null
          : { usedPercent, window: "month", resetsAt: new Date("2026-12-01T00:00:00.000Z") };
      }),
    },
  });
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  render(providerFor(createElement(LimitWarning), { fetch, messages: {} }));
  return { wasRead: () => read };
}

describe("the warning at a limit", () => {
  it("warns the owner at 80% of the Quota", async () => {
    show(80);

    const warning = await screen.findByRole("status");
    expect(warning.textContent).toContain("80%");
  });

  it("still warns once the Quota is spent", async () => {
    show(100);

    const warning = await screen.findByRole("status");
    expect(warning.textContent).toContain("100%");
  });

  it.each([79, null])("says nothing at %s", async (usedPercent) => {
    const { wasRead } = show(usedPercent);

    await waitFor(() => expect(wasRead()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
