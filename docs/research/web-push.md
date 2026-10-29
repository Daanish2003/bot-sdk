# Web push in the web app

Research for [#1016](https://github.com/Daanish2003/bot-sdk/issues/1016) (child of map [#975](https://github.com/Daanish2003/bot-sdk/issues/975), "Proactive defaults"). Researched 2026-10-30 against MDN, IETF RFCs, the WebKit blog, Apple's developer docs, web.dev and the library repos. Package versions were read from the npm registry on that date.

## Question

What does browser push notification for the web app (`apps/web`, TanStack Start) take: Web Push API and service worker, VAPID keys, subscription storage per device, browser support including iOS Safari as an installed PWA, and which library (a new dependency, so the owner picks)? What happens when a push is sent to a stale subscription?

## Answer

- **The app already has most of the client side.** `apps/web` ships a hand-written service worker (`public/sw.js`, registered in production builds only by `src/lib/service-worker.ts`), a manifest with `display: "standalone"` (`public/manifest.webmanifest`), and the Apple meta tags and touch icon in `src/routes/__root.tsx`. There is no push or notification code anywhere in `apps/web` or `packages/botsdk` today. Web push adds a `push` and a `notificationclick` handler to `sw.js`, plus a subscribe button.
- **Pieces:** a VAPID key pair (one per server, generated once), a "turn on notifications" button that calls `pushManager.subscribe()` from the click handler, a table of push subscriptions (one row per browser/device, keyed by `endpoint`, holding `p256dh` and `auth`, owned by a user), and a server sender that encrypts the payload (RFC 8291), signs a VAPID JWT (RFC 8292) and POSTs to the endpoint (RFC 8030).
- **Browsers:** Chrome/Edge 42+, Firefox 44+, Safari 16 on macOS 13+, and iOS/iPadOS 16.4+ **only as a Home Screen web app** whose manifest `display` is `standalone` or `fullscreen` (this app's is). No Apple Developer account is needed.
- **Every push must show a notification.** Chrome and Edge reject `subscribe()` without `userVisibleOnly: true`; Safari revokes the permission of a site whose push shows nothing. So web push can carry a SendToUser Message's text but not a silent "sync now" signal.
- **Stale subscription:** the push service answers **404 or 410**; the server deletes that row and does not retry. Anything else (429, 5xx) is retried with backoff; 403 / 400 are our bug (bad VAPID, bad headers) and retrying won't help.
- **Library options (a new dependency, owner's call):** `web-push` 3.6.7 (the de facto Node library, MPL-2.0, 5 deps, last release 2024-01 but repo active), `@pushforge/builder` 2.0.5 (MIT, zero deps, Web Crypto, returns a request you `fetch`), `@block65/webcrypto-web-push` 2.0.0 (MIT, Web Crypto). A PWA build plugin (`vite-plugin-pwa` 2.0.0) is **not** needed since the app already has its own worker.
- **Local testing:** `http://localhost` is a secure context, so Chrome/Firefox desktop can subscribe and receive pushes from a dev machine (the browser's push service is reached outbound; no tunnel). The current worker registers only in production builds, so testing needs `vite build && vite preview` or a dev-mode registration. iOS needs the app served over HTTPS and added to the Home Screen, so it needs a tunnel (unverified in this repo).

## What `apps/web` has today

Verified by reading the files on `main` (469a7e4b):

| Piece                    | State                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service worker           | `apps/web/public/sw.js`, hand-written, no build plugin. Handles `install`, `activate`, `fetch` only (asset cache + offline page). Scope `/`.                               |
| Registration             | `apps/web/src/lib/service-worker.ts` `registerServiceWorker()`; returns early unless `import.meta.env.PROD`.                                                               |
| Manifest                 | `apps/web/public/manifest.webmanifest`: `display: "standalone"`, `start_url: "/"`, 192/512/maskable icons. Linked from `__root.tsx`.                                       |
| iOS install meta         | `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon` in `apps/web/src/routes/__root.tsx`.                                           |
| Push / Notification code | None. No `push`, `notificationclick`, `Notification.requestPermission`, `pushManager` or VAPID anywhere in `apps/web/src`, `apps/web/public` or `packages/botsdk`.         |
| Delivery seam            | `packages/botsdk/bot/src/bot/conversation/email-delivery.ts`: `DeliveryChannel = "email"`, one `channel.deliver` job per Message and Channel. Web push would be a sibling. |

## How web push works

### Client: subscribe

1. The page has an active service worker (MDN Push API [M1]: "For an app to receive push messages, it has to have an active service worker").
2. On a user click, call `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <VAPID public key> })`. MDN [M2]: `applicationServerKey` is "an ECDSA P-256 public key that the push server will use to authenticate your application server"; `userVisibleOnly` "is required in some browsers like Chrome and Edge. They will reject the Promise if `userVisibleOnly` is not set to `true`." BCD notes Chrome also requires `applicationServerKey` [BCD].
3. Subscribing must happen in a user gesture. MDN [M2]: "browsers will explicitly disallow notifications not triggered in response to a user gesture. Firefox is already doing this from version 72." Apple [A1]: "When the user completes the gesture, call the push subscription method immediately from the gesture's event handler code."
4. Send the resulting `PushSubscription` (its `toJSON()`: `endpoint`, `keys.p256dh`, `keys.auth`, `expirationTime`) to the server. MDN [M1]: "The endpoint URL therefore needs to be kept secret", and protect the save route against CSRF.
5. The API is a secure-context feature [M2]; `http://localhost` counts as secure [M3].

### Service worker: receive and show

- A `push` event handler reads `event.data.json()` and calls `self.registration.showNotification(title, { body, data })` inside `event.waitUntil(...)` [M1].
- A `notificationclick` handler focuses or opens the Conversation URL (`clients.openWindow` / `client.focus`). Standard pattern; not separately cited.
- Apple [A1]: "Safari doesn't support invisible push notifications. Present push notifications to the user immediately after your service worker receives them. If you don't, Safari revokes the push notification permission for your site."
- Optional: `navigator.setAppBadge()` for an unread count on the Home Screen icon (Safari 17, iOS 16.4, Chrome 81; not Firefox) [A1][BCD].

### Server: VAPID keys

- One P-256 key pair per server, generated once and reused (web-push README [L1]: "You should create these keys once, store them and use them for all future messages you send"). The public key goes to the browser; the private key is a server secret (an env var through `.env.schema` / varlock in this repo).
- Each request carries an `Authorization: vapid t=<JWT>, k=<public key>` header (RFC 8292 [R3]). Apple [A1] rejects a JWT whose `sub` isn't a URL or `mailto:`, whose `aud` isn't the push service origin, or whose `exp` is more than a day ahead, and asks senders not to refresh the JWT more than once an hour. The libraries below build this.
- Changing the VAPID key orphans every existing subscription (Apple returns `VapidPkHashMismatch` [A1]); rotating means re-subscribing every device.

### Server: send

A POST to the subscription's `endpoint` with:

- `TTL` (required by RFC 8030 [R1]: "An application server MUST include the TTL (Time-To-Live) header field"). Apple stores for up to 30 days [A1].
- `Content-Encoding: aes128gcm` and the payload encrypted per RFC 8291 [R2] with the subscription's `p256dh`/`auth`.
- Optional `Urgency` (`very-low` | `low` | `normal` | `high`) and `Topic` (≤ 32 base64url chars; a newer message with the same topic replaces an undelivered one) [R1][A1].
- Payload limit: RFC 8030 only promises that ≤ 4096 bytes is never refused [R1]; Apple's limit is 4 KB [A1]. So send the Message text (trimmed) plus ids, not attachments; the client fetches the rest.

### Subscription storage per device

One row per subscription, not per user: each browser profile and each installed iOS web app gets its own `endpoint` ("Each subscription is unique to a service worker" [M1]). A sketch (a schema change, so the owner's call):

| column                     | note                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `endpoint` (unique)        | the push service URL; identity of the row                    |
| `p256dh`, `auth`           | encryption keys from `subscription.toJSON().keys`            |
| `user_id`                  | owner; a user may have many                                  |
| `expiration_time`          | nullable; most push services return `null`                   |
| `user_agent`, `created_at` | to show "this device" in settings and let the user remove it |

Upsert on `endpoint` when the page re-subscribes (the browser returns the same subscription while it is valid), delete on sign-out from that device and on 404/410.

## Browser support

From MDN browser-compat-data 8.1.7 [BCD], WebKit [W1] and Apple [A1]:

| Browser                  | `PushManager` / `showNotification`   | `pushsubscriptionchange`                                            |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------- |
| Chrome / Edge (Chromium) | 42+                                  | 138+                                                                |
| Firefox                  | 44+                                  | 44+, partial: no `oldSubscription` / `newSubscription` on the event |
| Safari macOS             | 16+ (macOS 13 Ventura+)              | 16+                                                                 |
| Safari iOS / iPadOS      | 16.4+, **Home Screen web apps only** | **not supported**                                                   |

MDN marks Push as Baseline "widely available" since March 2023 [M1].

**iOS specifics** [W1][A1]:

- Push works only after the user adds the site to the Home Screen; in a Safari tab there is no `PushManager`. WebKit: "A web app that has been added to the Home Screen can request permission to receive push notifications".
- The manifest's `display` must be `standalone` or `fullscreen` [W1]. This app's is `standalone`.
- Permission must be asked "in response to direct user interaction" [W1].
- "You do not need to be a member of the Apple Developer Program" [W1].
- Servers behind an egress allow-list must allow `https://*.push.apple.com` [W1][A1].
- Because iOS lacks `pushsubscriptionchange`, a subscription that changes is only noticed when the app next runs: re-call `pushManager.getSubscription()` on load and upsert it.

**Firefox quota:** Firefox limits pushes that don't show a notification; pushes that do are exempt [M1]. Not a concern if every push shows one.

## Stale subscriptions

- RFC 8030 [R1] §7.3: "A push service MAY expire a subscription at any time"; a push to an expired subscription gets **404 Not Found**. **410 Gone** is the other "this subscription is dead" answer.
- Apple [A1]: `410` = "The device token has expired."; `404` there means a bad `:path`, which for a stored endpoint also means the endpoint is unusable.
- web.dev [D1]: on 404 or 410 "the subscription has expired or is no longer valid", so delete it from the database; rethrow other errors.
- `web-push` rejects with a `WebPushError` carrying `statusCode`, `headers`, `body` and `endpoint` [L1 source `src/web-push-error.js`], so the check is `if (err.statusCode === 404 || err.statusCode === 410) delete`.
- Other codes from Apple [A1]: 400 (bad headers, see `reason`), 403 (auth/VAPID), 413 (payload > 4 KB), 429 (too many to one device), 500/503 (retry). RFC 8030 says 429 should come with `Retry-After` [R1].
- How users go stale in practice: they revoke permission, clear site data, uninstall the iOS Home Screen app, or the push service rotates the subscription. None of these tell the server; the next send's 404/410 is the only signal (plus `pushsubscriptionchange` where supported).
- A `201` means the push service accepted it, not that the device got it [R1].

**Fit with the delivery job:** the existing `channel.deliver` job (one per Message and Channel, retried by the runner) fits. A web-push delivery would fan out to each of the user's subscriptions; 404/410 deletes that row and counts as done, not as a failure to retry; 429/5xx throw so the runner retries.

## Library options

A new dependency, so the owner picks. Versions and dates from the npm registry, 2026-10-30.

| Package                                | Latest | Published  | License | Runtime deps                                                  | Notes                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ------ | ---------- | ------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-push` (+ `@types/web-push` 3.6.4) | 3.6.7  | 2024-01-16 | MPL-2.0 | `asn1.js`, `http_ece`, `https-proxy-agent`, `jws`, `minimist` | De facto Node library. `generateVAPIDKeys()`, `setVapidDetails()`, `sendNotification(sub, payload, { TTL, urgency, topic, contentEncoding })`; throws `WebPushError` with `statusCode`. Node ≥ 16. No release since 2024-01, but the repo (web-push-libs/web-push) was pushed 2026-10-26 and isn't archived. Types are separate. |
| `@pushforge/builder`                   | 2.0.5  | 2026-04-23 | MIT     | none                                                          | Web Crypto; Node 20+, Bun, Deno, Workers. `buildPushHTTPRequest({ privateJWK, subscription, message })` returns `{ endpoint, headers, body }`; you `fetch` it and read the status yourself. CLI `vapid` generates keys. TypeScript-first.                                                                                        |
| `@block65/webcrypto-web-push`          | 2.0.0  | 2026-09-03 | MIT     | `uint8array-extras`                                           | Web Crypto implementation. README not read in depth (unverified API details).                                                                                                                                                                                                                                                    |
| Hand-rolled                            | n/a    | n/a        | n/a     | none                                                          | RFC 8291 encryption + RFC 8292 JWT over Node `crypto`. Possible but the encryption is easy to get subtly wrong; not recommended for a lab.                                                                                                                                                                                       |

`vite-plugin-pwa` 2.0.0 (Workbox) is the usual PWA plugin for Vite, but this app deliberately hand-writes its worker ("no build plugin" in `sw.js`), so push needs no plugin. Whether TanStack Start offers any push or service-worker helper was not checked; none is needed.

Lean: `web-push` is the most used and its `WebPushError.statusCode` makes stale handling one line; `@pushforge/builder` is the zero-dependency, MIT, Web Crypto choice that returns a plain `fetch` request, which suits the existing job model. Either works on the Node server the app runs.

## Not verified

- `@block65/webcrypto-web-push` API details.
- Android Chrome as an installed PWA versus a tab: not checked separately (Chrome Android supports push in a tab per BCD, no install required).
- iOS end to end from a dev machine: needs HTTPS (a tunnel) and a real device; not tried.
- Exact Chrome (FCM) and Firefox (autopush) payload limits beyond the 4096-byte RFC floor.
- Whether TanStack Start's dev server serves `public/sw.js` with the right scope in dev mode; the app only registers it in production today.

## Sources

- [M1] MDN, Push API: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- [M2] MDN, `PushManager.subscribe()`: https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
- [M3] MDN, Secure contexts: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
- [BCD] MDN browser-compat-data 8.1.7 (`api.PushManager`, `api.PushManager.subscribe`, `api.ServiceWorkerGlobalScope.pushsubscriptionchange_event`, `api.ServiceWorkerRegistration.showNotification`, `api.Navigator.setAppBadge`): https://github.com/mdn/browser-compat-data
- [R1] RFC 8030, Generic Event Delivery Using HTTP Push: https://www.rfc-editor.org/rfc/rfc8030
- [R2] RFC 8291, Message Encryption for Web Push: https://www.rfc-editor.org/rfc/rfc8291
- [R3] RFC 8292, VAPID: https://www.rfc-editor.org/rfc/rfc8292
- [W1] WebKit blog, Web Push for Web Apps on iOS and iPadOS: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- [A1] Apple, Sending web push notifications in web apps and browsers: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- [D1] web.dev, Sending messages with web push libraries: https://web.dev/articles/sending-messages-with-web-push-libraries
- [L1] web-push README and `src/web-push-error.js`: https://github.com/web-push-libs/web-push
- [L2] @pushforge/builder README: https://github.com/draphy/pushforge
- [L3] @block65/webcrypto-web-push: https://github.com/block65/webcrypto-web-push
- npm registry metadata for each package: https://registry.npmjs.org/
