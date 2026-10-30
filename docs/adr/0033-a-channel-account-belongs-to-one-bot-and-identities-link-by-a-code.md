---
Status: accepted
---

# A Channel account belongs to one Bot, its credentials come from the owner, and identities link by a code

Decided in [One platform bot per Bot, or one per Host](https://github.com/Daanish2003/bot-sdk/issues/1036) and [How the owner links a platform identity](https://github.com/Daanish2003/bot-sdk/issues/1035), on the [Messaging Channels](https://github.com/Daanish2003/bot-sdk/issues/976) map. Builds on ADR 0029 (one package per adapter) and ADR 0010 (the keyring).

A Bot reaches Telegram, Discord, Slack, Matrix, WhatsApp and SMS through **Channel accounts**: a Telegram bot token, a Discord application, a Slack app, a Matrix account, a WhatsApp number or a Telnyx number. Each Channel account belongs to exactly one Bot, so each Bot is its own contact on the platform, as it has its own email address. Nothing routes by a picker or `@BotName`. A number connected to another Bot moves there.

The owner makes the platform bot themselves and pastes its credentials into the Bot's settings. The SDK keeps them in a per-Bot table, encrypted with the ADR 0010 keyring, and the channel plugin's `rotateKeys` re-encrypts them. The Host's env holds none of them. Revoked or rejected credentials stop the account's listener and mark it as needing attention; there is no retry loop.

The owner proves who they are on each platform with a **link code**: a one-time code from their settings, valid 10 minutes, that they send to any of their Bots on any messaging Channel. The first message from an unknown sender that carries a valid code makes that sender a **Linked identity** of the user, for the platform it arrived on. Telegram and WhatsApp get one-tap deep links. A phone number is proved the same way, never typed in. A Linked identity belongs to the user, so all their Bots know it:

- one per platform per user (a new link replaces the old);
- one user per identity on a Host (a code from a sender linked to someone else is refused);
- a link gets a short confirmation; a bad or expired code gets no reply, like any stranger.

Unlinking takes effect at once, and messages from that identity are dropped silently again. Email keeps its own rule: the user's verified account email.

## Considered Options

- **One platform bot per Host, shared by all users' Bots**: one token in the Host's env, as ADR 0023 does for Provider credentials. A user with several Bots would need a picker or `@BotName` in every chat, and a Host operator would see every user's messages pass through one bot it owns.
- **Credentials in the Host's env per Bot**: the lab has one owner, but a Host with many users can't redeploy for each new Bot.
- **Storing them as Secrets**: Secrets are for commands on the Computer, and the model sees their names. A Channel token is the SDK's, not the Bot's.
- **Platform OAuth to link** (Sign in with Slack, Discord OAuth): one flow per platform, and none for Telegram, Matrix or phones. A code sent from the platform works on all six.
- **Typing a phone number into settings**: it proves nothing about who holds the phone.

## Consequences

- A new per-Bot Channel account table and a per-user Linked identity table, plus short-lived link codes.
- The Host process runs one listener per Channel account that has a listening mode (messaging-inbound research, #1037). One process holds each.
- WhatsApp and SMS numbers cost money or registration, so an owner will usually connect them to one Bot only.
