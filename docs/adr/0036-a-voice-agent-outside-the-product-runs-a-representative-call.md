---
Status: proposed
---

# A Voice agent outside the product runs a Representative's Call, and speech skips the outbound gate

Decided in [Who holds a phone call and runs the conversation](https://github.com/Daanish2003/bot-sdk/issues/1367), on the [Voice calls map](https://github.com/Daanish2003/bot-sdk/issues/979). It reverses the ruling on [How calls reach a Representative](https://github.com/Daanish2003/bot-sdk/issues/1165) that a realtime model must not act as the Representative.

A Representative takes phone calls through a **Voice agent**: a program outside the product that holds the Call and runs the conversation with its own model. The first and only one for now is a LiveKit agent, with a reference copy in `apps/livekit-test`, outside the pnpm workspace. `apps/web` and the packages hold no call-handling code and never depend on LiveKit.

The product keeps a voice account in its setup and serves three routes the Voice agent calls, authenticated by a per-account secret:

- **Call start** returns `decline`, or the current Release's instructions, the live topics, published facts, a greeting and a time limit. The Release is served per Call, so a new approval needs no redeploy and no vendor API key is stored.
- **`record_request`** only stores what the caller wants. Nothing acts during a Call, except that `emergency: true` pages the owner.
- **Call end** receives the transcript. It joins the Customer's thread as one entry, and a normal Turn reviews it: it may text through the gate, hand a request to the Bot, or flag the Call to the owner.

Every caller is unverified on a Call, because the number is only what the vendor reports. No Customer memory reaches the Voice agent.

## Considered Options

- **Telnyx SIP to GPT-Live, with each request run as a normal Turn**: needs an OpenAI key the owner doesn't have, and ties the product to one vendor.
- **The Representative answers every turn through an agent endpoint**: every word would pass the gate, but the product would have to wait on Turns during live speech, and vendors differ in how well they support it.
- **A voice gateway we run, or calls held in the Host with provider adapters**: the owner wants no call-handling code in the product.

## Consequences

- `passGate` doesn't cover speech. `auto` and `draft` are prompt instructions on a Call, and a model can ignore them. The post-call review detects this but doesn't prevent it.
- No emergency scan or owner takeover happens during a Call.
- The Release's `model`, `tools` and `switches` don't apply on a Call.
- What is said on a Call, and the published facts and documents, go to the Voice agent's vendors.
- Vendor cost is invisible to the money caps, and the 10-minute limit is enforced by the Voice agent.
- A Call counts as the Customer starting the contact, so one follow-up text can pass the gate on SMS.
- Adding another vendor means another Voice agent against the same three routes.
