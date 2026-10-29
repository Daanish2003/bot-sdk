// @vitest-environment jsdom
import {
  type NotificationSettings,
  notificationSettingsSchema,
} from "@botsdk/client/bot/notifications";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { NotificationsSection } from "../../src/settings/notifications-section";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

/** A stand-in for the server's `notifications` router that holds the settings and records saves. */
function fakeNotificationsServer(
  settings: NotificationSettings,
  { failing }: { failing?: boolean } = {},
) {
  const saved: NotificationSettings[] = [];
  const router = {
    notifications: {
      get: os.handler(() => {
        if (failing) throw new ORPCError("INTERNAL_SERVER_ERROR");
        return settings;
      }),
      update: os.input(notificationSettingsSchema).handler(({ input }) => {
        saved.push(input);
        settings = input;
        return input;
      }),
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, saved };
}

function mount(server: ReturnType<typeof fakeNotificationsServer>) {
  return render(
    providerFor(createElement(NotificationsSection), {
      fetch: server.fetch,
      messages: {},
      // A failed read shows its failure at once, without the default retries.
      seed: (queryClient) => queryClient.setDefaultOptions({ queries: { retry: false } }),
    }),
  );
}

const radio = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", {
    name,
  }) as HTMLButtonElement;

const nothingSet = { quietHours: null, urgent: null, other: null };

describe("the Notifications section", () => {
  it("shows quiet hours off and both choices on the default for a user who set nothing", async () => {
    mount(fakeNotificationsServer(nothingSet));

    const quiet = (await screen.findByRole("checkbox", { name: "Quiet hours" })) as HTMLElement;
    await waitFor(() => expect(quiet.getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(radio("Urgent messages", "Where I last wrote").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(radio("Other messages", "Where I last wrote").getAttribute("aria-checked")).toBe("true");
  });

  it("shows saved settings", async () => {
    mount(
      fakeNotificationsServer({
        quietHours: { start: "22:00", end: "07:00" },
        urgent: "email",
        other: "in_app",
      }),
    );

    expect(((await screen.findByLabelText("From")) as HTMLInputElement).value).toBe("22:00");
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("07:00");
    expect(radio("Urgent messages", "Email").getAttribute("aria-checked")).toBe("true");
    expect(radio("Other messages", "In-app only").getAttribute("aria-checked")).toBe("true");
  });

  it("saves quiet hours and both choices", async () => {
    const server = fakeNotificationsServer(nothingSet);
    mount(server);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Quiet hours" }));
    fireEvent.change(await screen.findByLabelText("From"), { target: { value: "23:30" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "06:45" } });
    fireEvent.click(radio("Urgent messages", "Email"));
    fireEvent.click(radio("Other messages", "In-app only"));
    fireEvent.click(screen.getByRole("button", { name: "Save notifications" }));

    await waitFor(() =>
      expect(server.saved).toEqual([
        { quietHours: { start: "23:30", end: "06:45" }, urgent: "email", other: "in_app" },
      ]),
    );
  });

  it("saves quiet hours off, and a choice back on the default", async () => {
    const server = fakeNotificationsServer({
      quietHours: { start: "22:00", end: "07:00" },
      urgent: "email",
      other: "email",
    });
    mount(server);

    await screen.findByLabelText("From");
    fireEvent.click(screen.getByRole("checkbox", { name: "Quiet hours" }));
    fireEvent.click(radio("Other messages", "Where I last wrote"));
    fireEvent.click(screen.getByRole("button", { name: "Save notifications" }));

    await waitFor(() =>
      expect(server.saved).toEqual([{ quietHours: null, urgent: "email", other: null }]),
    );
  });

  it("says so when the settings can't load", async () => {
    mount(fakeNotificationsServer(nothingSet, { failing: true }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't load your notification settings",
    );
    expect(screen.queryByRole("button", { name: "Save notifications" })).toBeNull();
  });

  it("won't save quiet hours that start when they end", async () => {
    mount(fakeNotificationsServer(nothingSet));

    fireEvent.click(await screen.findByRole("checkbox", { name: "Quiet hours" }));
    fireEvent.change(await screen.findByLabelText("From"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "08:00" } });

    const save = screen.getByRole("button", { name: "Save notifications" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
