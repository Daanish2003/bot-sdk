/**
 * Whether this browser can take web push (spec #1024): `needs-home-screen` on an iPhone or iPad
 * whose Safari offers push only to an app on the Home Screen (iOS 16.4+).
 */
export type PushSupport = "supported" | "needs-home-screen" | "unsupported";

/** A device's subscription as the server takes it. */
export type DeviceSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/** This device's web push, as the Notifications section uses it; tests pass a fake. */
export type PushDevice = {
  support: () => PushSupport;
  /** This device's subscription, or `null` when it has none. */
  current: () => Promise<DeviceSubscription | null>;
  /**
   * Asks the user for notifications and subscribes the device with the Host's VAPID `publicKey`.
   * Throws `PushDeniedError` when the user or the browser refuses notifications.
   */
  subscribe: (publicKey: string) => Promise<DeviceSubscription>;
  /** Removes this device's subscription, and returns its endpoint (`null` when it had none). */
  unsubscribe: () => Promise<string | null>;
};

/** The user, or the browser, refused notifications for this site. */
export class PushDeniedError extends Error {
  constructor() {
    super("Notifications are blocked for this site");
    this.name = "PushDeniedError";
  }
}

/** Where `pushSupportOf` reads the browser from. */
export type BrowserTraits = {
  userAgent: string;
  maxTouchPoints: number;
  /** Running as an installed app (display-mode standalone). */
  standalone: boolean;
  /** The browser has service workers, `PushManager` and `Notification`. */
  hasPush: boolean;
};

/** Whether a browser with `traits` can take web push. */
export function pushSupportOf(traits: BrowserTraits): PushSupport {
  if (traits.hasPush) return "supported";
  // iPadOS reports itself as a Mac; only its touch points tell it apart.
  const ios =
    /iPad|iPhone|iPod/.test(traits.userAgent) ||
    (/Macintosh/.test(traits.userAgent) && traits.maxTouchPoints > 1);
  return ios && !traits.standalone ? "needs-home-screen" : "unsupported";
}

/** A base64url key as the bytes `PushManager.subscribe` takes. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A browser subscription as the server takes it. */
function deviceSubscriptionOf(subscription: PushSubscription): DeviceSubscription {
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error("The subscription has no keys");
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/**
 * The app's service worker registration, or `null`: it is registered in production builds only,
 * so in development push isn't available.
 */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** This browser's web push, through the app's service worker. */
export const browserPushDevice: PushDevice = {
  support: () =>
    pushSupportOf({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
      standalone:
        window.matchMedia?.("(display-mode: standalone)").matches === true ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
      hasPush: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    }),
  current: async () => {
    const subscription = await (await registration())?.pushManager.getSubscription();
    return subscription ? deviceSubscriptionOf(subscription) : null;
  },
  subscribe: async (publicKey) => {
    if ((await Notification.requestPermission()) !== "granted") throw new PushDeniedError();
    const worker = await registration();
    if (!worker) throw new Error("The app's service worker isn't registered");
    const subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
    return deviceSubscriptionOf(subscription);
  },
  unsubscribe: async () => {
    const subscription = await (await registration())?.pushManager.getSubscription();
    if (!subscription) return null;
    await subscription.unsubscribe();
    return subscription.endpoint;
  },
};
