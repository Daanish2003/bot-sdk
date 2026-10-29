// @vitest-environment jsdom
import type { CustomRule, CustomRuleMode } from "@botsdk/client/bot/rule";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { RulesPage } from "../../src/settings/rules-page";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const at = new Date("2026-10-29T09:00:00.000Z");
const modes = ["without_asking", "pre_approved", "ask", "hand_off"] as const;

const ruleOf = (n: number, over: Partial<CustomRule> = {}): CustomRule => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  text: `Rule ${n}`,
  mode: "ask",
  state: "active",
  proposedByBotId: null,
  createdAt: new Date(at.getTime() + n),
  updatedAt: new Date(at.getTime() + n),
  ...over,
});

/** A stand-in for the server's `rules` router that holds `rules` and records every write. */
function fakeRulesServer(rules: CustomRule[]) {
  const calls: { method: string; input: unknown }[] = [];
  const mode = z.enum(modes);
  const router = {
    rules: {
      list: os.handler(() => rules.map((rule) => ({ ...rule }))),
      create: os.input(z.object({ text: z.string(), mode })).handler(({ input }) => {
        calls.push({ method: "create", input });
        const rule = ruleOf(rules.length + 1, { text: input.text, mode: input.mode });
        rules.push(rule);
        return rule;
      }),
      update: os
        .input(z.object({ ruleId: z.string(), text: z.string().optional(), mode: mode.optional() }))
        .handler(({ input }) => {
          calls.push({ method: "update", input });
          const rule = rules.find((candidate) => candidate.id === input.ruleId)!;
          Object.assign(rule, {
            ...(input.text !== undefined && { text: input.text }),
            ...(input.mode !== undefined && { mode: input.mode as CustomRuleMode }),
            updatedAt: new Date(rule.updatedAt.getTime() + 1000),
          });
          return rule;
        }),
      delete: os.input(z.object({ ruleId: z.string() })).handler(({ input }) => {
        calls.push({ method: "delete", input });
        rules.splice(
          rules.findIndex((rule) => rule.id === input.ruleId),
          1,
        );
      }),
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, calls, rules };
}

function mount(server: ReturnType<typeof fakeRulesServer>) {
  return render(providerFor(createElement(RulesPage), { fetch: server.fetch, messages: {} }));
}

const pill = (within_: HTMLElement, name: string) =>
  within(within_).getByRole("radio", { name }) as HTMLButtonElement;

describe("the rules page", () => {
  it("shows the footnote and an empty list, then adds a rule with a mode", async () => {
    const server = fakeRulesServer([]);
    mount(server);

    expect(await screen.findByText("No rules yet.")).toBeTruthy();
    expect(screen.getByText(/Rules reach only the calls Auto-review checks/)).toBeTruthy();
    expect(screen.getByText("0 of 50 rules")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    const row = screen.getByRole("listitem");
    const save = within(row).getByRole("button", { name: "Save rule" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // All four modes are offered.
    for (const name of ["Without asking", "If pre-approved", "Ask before", "Hand off to me"]) {
      expect(pill(row, name)).toBeTruthy();
    }
    fireEvent.change(within(row).getByLabelText("Rule"), {
      target: { value: "  Reply to emails from anyone @acme.com  " },
    });
    fireEvent.click(pill(row, "Without asking"));
    fireEvent.click(save);

    await waitFor(() =>
      expect(server.calls).toEqual([
        {
          method: "create",
          input: { text: "Reply to emails from anyone @acme.com", mode: "without_asking" },
        },
      ]),
    );
    expect(await screen.findByDisplayValue("Reply to emails from anyone @acme.com")).toBeTruthy();
    expect(screen.getByText("1 of 50 rules")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("edits a rule's text on blur and its mode on a pill, and deletes it", async () => {
    const server = fakeRulesServer([ruleOf(1), ruleOf(2, { mode: "hand_off" })]);
    mount(server);

    const field = (await screen.findByDisplayValue("Rule 1")) as HTMLTextAreaElement;
    const row = field.closest("li")!;
    expect(pill(row, "Ask before").getAttribute("aria-checked")).toBe("true");
    fireEvent.change(field, { target: { value: "Rule one, reworded" } });
    fireEvent.blur(field);

    await waitFor(() =>
      expect(server.calls).toEqual([
        { method: "update", input: { ruleId: server.rules[0]!.id, text: "Rule one, reworded" } },
      ]),
    );

    const reworded = (await screen.findByDisplayValue("Rule one, reworded")).closest("li")!;
    fireEvent.click(pill(reworded, "If pre-approved"));
    await waitFor(() =>
      expect(server.calls.at(-1)).toEqual({
        method: "update",
        input: { ruleId: server.rules[0]!.id, mode: "pre_approved" },
      }),
    );
    await waitFor(() =>
      expect(
        pill(
          screen.getByDisplayValue("Rule one, reworded").closest("li")!,
          "If pre-approved",
        ).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    // The other rule, set to hand off, shows that pill chosen.
    const other = screen.getByDisplayValue("Rule 2").closest("li")!;
    expect(pill(other, "Hand off to me").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(other).getByRole("button", { name: "Delete rule" }));

    await waitFor(() =>
      expect(server.calls.at(-1)).toEqual({
        method: "delete",
        input: { ruleId: ruleOf(2).id },
      }),
    );
    await waitFor(() => expect(screen.queryByDisplayValue("Rule 2")).toBeNull());
    expect(screen.getByText("1 of 50 rules")).toBeTruthy();
  });

  it("puts a blank edit back instead of saving it", async () => {
    const server = fakeRulesServer([ruleOf(1)]);
    mount(server);

    const field = (await screen.findByDisplayValue("Rule 1")) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.blur(field);

    await waitFor(() => expect(field.value).toBe("Rule 1"));
    expect(server.calls).toEqual([]);
  });

  it("shows the limit at 50 rules and turns Add a rule off, until one is deleted", async () => {
    const rules = Array.from({ length: 50 }, (_, n) => ruleOf(n + 1));
    const server = fakeRulesServer([...rules, ruleOf(51, { state: "proposed" })]);
    mount(server);

    expect(await screen.findByText("50 of 50 rules")).toBeTruthy();
    expect(screen.getByText(/You have 50 rules, the most allowed/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add a rule" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // A proposed rule isn't listed to edit here.
    expect(screen.queryByDisplayValue("Rule 51")).toBeNull();

    fireEvent.click(
      within(screen.getByDisplayValue("Rule 1").closest("li")!).getByRole("button", {
        name: "Delete rule",
      }),
    );

    await waitFor(() => expect(screen.getByText("49 of 50 rules")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Add a rule" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByText(/the most allowed/)).toBeNull();
  });
});
