// @vitest-environment jsdom
import {
  type NotificationSettings,
  notificationSettingsSchema,
  pushEndpointInput,
  pushSubscriptionSchema,
} from "@botsdk/client/bot/notifications";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { NotificationsSection } from "../../src/settings/notifications-section";
import {
  type DeviceSubscription,
  type PushDevice,
  PushDeniedError,
  type PushSupport,
  pushSupportOf,
} from "../../src/settings/push-device";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

/** A stand-in for the server's `notifications` router that holds the settings and records saves. */
function fakeNotificationsServer(
  settings: NotificationSettings,
  { failing, pushKey = null }: { failing?: boolean; pushKey?: string | null } = {},
) {
  const saved: NotificationSettings[] = [];
  const subscribed: DeviceSubscription[] = [];
  const unsubscribed: string[] = [];
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
      push: {
        key: os.handler(() => pushKey),
        subscribe: os.input(pushSubscriptionSchema).handler(({ input }) => {
          subscribed.push(input);
        }),
        unsubscribe: os.input(pushEndpointInput).handler(({ input }) => {
          unsubscribed.push(input.endpoint);
        }),
      },
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, saved, subscribed, unsubscribed };
}

const phone: DeviceSubscription = {
  endpoint: "https://push.example/send/phone",
  keys: { p256dh: "BKey", auth: "auth" },
};

/** A stand-in for this browser's push: its `support`, and the device's subscription, if any. */
function fakeDevice(
  support: PushSupport,
  {
    subscription = null,
    denied = false,
  }: { subscription?: DeviceSubscription | null; denied?: boolean } = {},
) {
  const keys: string[] = [];
  let current = subscription;
  const device: PushDevice = {
    support: () => support,
    current: async () => current,
    subscribe: async (publicKey) => {
      keys.push(publicKey);
      if (denied) throw new PushDeniedError();
      current = phone;
      return phone;
    },
    unsubscribe: async () => {
      const endpoint = current?.endpoint ?? null;
      current = null;
      return endpoint;
    },
  };
  return { device, keys };
}

function mount(server: ReturnType<typeof fakeNotificationsServer>, pushDevice?: PushDevice) {
  return render(
    providerFor(createElement(NotificationsSection, { pushDevice }), {
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
describe("web push in the Notifications section", () => {
  const key = "BHostVapidKey";

  it("isn't offered when the Host has no web push", async () => {
    mount(fakeNotificationsServer(nothingSet), fakeDevice("supported").device);

    await screen.findByRole("radiogroup", { name: "Urgent messages" });
    expect(screen.queryByRole("radio", { name: "Web push" })).toBeNull();
    expect(screen.queryByText("Web push on this device")).toBeNull();
  });

  it("is a choice for urgent messages and the rest, and saves", async () => {
    const server = fakeNotificationsServer(nothingSet, { pushKey: key });
    mount(server, fakeDevice("supported").device);

    await screen.findByText("Web push on this device");
    fireEvent.click(radio("Urgent messages", "Web push"));
    fireEvent.click(radio("Other messages", "Web push"));
    fireEvent.click(screen.getByRole("button", { name: "Save notifications" }));

    await waitFor(() =>
      expect(server.saved).toEqual([{ quietHours: null, urgent: "push", other: "push" }]),
    );
  });

  it("says when this browser can't take push", async () => {
    mount(fakeNotificationsServer(nothingSet, { pushKey: key }), fakeDevice("unsupported").device);

    expect(await screen.findByText("This browser can't show push notifications.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enable push on this device" })).toBeNull();
  });

  it("says that an iPhone needs the app on its Home Screen", async () => {
    mount(
      fakeNotificationsServer(nothingSet, { pushKey: key }),
      fakeDevice("needs-home-screen").device,
    );

    expect((await screen.findByText(/Home Screen/)).textContent).toContain("iOS 16.4");
    expect(screen.queryByRole("button", { name: "Enable push on this device" })).toBeNull();
  });

  it("enables push on this device with the Host's key, and saves its subscription", async () => {
    const server = fakeNotificationsServer(nothingSet, { pushKey: key });
    const { device, keys } = fakeDevice("supported");
    mount(server, device);

    fireEvent.click(await screen.findByRole("button", { name: "Enable push on this device" }));

    expect((await screen.findByRole("status")).textContent).toBe("Push is on for this device.");
    expect(keys).toEqual([key]);
    expect(server.subscribed).toEqual([phone]);
  });

  it("shows push on for a subscribed device, and turns it off", async () => {
    const server = fakeNotificationsServer(nothingSet, { pushKey: key });
    mount(server, fakeDevice("supported", { subscription: phone }).device);

    expect((await screen.findByRole("status")).textContent).toBe("Push is on for this device.");
    fireEvent.click(screen.getByRole("button", { name: "Turn off push on this device" }));

    await screen.findByRole("button", { name: "Enable push on this device" });
    expect(server.unsubscribed).toEqual([phone.endpoint]);
  });

  it("saves nothing when notifications are blocked", async () => {
    const server = fakeNotificationsServer(nothingSet, { pushKey: key });
    const { device, keys } = fakeDevice("supported", { denied: true });
    mount(server, device);

    fireEvent.click(await screen.findByRole("button", { name: "Enable push on this device" }));

    await waitFor(() => expect(keys).toEqual([key]));
    expect(server.subscribed).toEqual([]);
    expect(screen.getByRole("button", { name: "Enable push on this device" })).toBeTruthy();
  });
});

describe("whether a browser can take web push", () => {
  const traits = { userAgent: "", maxTouchPoints: 0, standalone: false, hasPush: false };
  const iPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

  it("can, with push in the browser", () => {
    expect(pushSupportOf({ ...traits, hasPush: true })).toBe("supported");
    expect(pushSupportOf({ ...traits, userAgent: iPhone, standalone: true, hasPush: true })).toBe(
      "supported",
    );
  });

  it("needs the Home Screen on an iPhone, or an iPad that says it is a Mac, in Safari", () => {
    expect(pushSupportOf({ ...traits, userAgent: iPhone })).toBe("needs-home-screen");
    expect(pushSupportOf({ ...traits, userAgent: mac, maxTouchPoints: 5 })).toBe(
      "needs-home-screen",
    );
  });

  it("can't on an installed app with no push (before iOS 16.4), or a browser without it", () => {
    expect(pushSupportOf({ ...traits, userAgent: iPhone, standalone: true })).toBe("unsupported");
    expect(pushSupportOf({ ...traits, userAgent: mac })).toBe("unsupported");
  });
});
