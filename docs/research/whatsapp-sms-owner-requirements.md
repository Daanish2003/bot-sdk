# What a lab owner must do for WhatsApp and SMS

Research for issue #1042 (child of the Messaging Channels map #976). Researched 2026-10-30 against vendor docs fetched that day. Builds on `docs/research/messaging-channel-apis.md` (WhatsApp part) and `docs/research/telnyx-openai-realtime.md` (SMS part, sections 5 and 7); it goes deeper and does not repeat them.

Context: the repo is a lab, never deployed. The owner is one hobbyist who texts their own Bot. The Bot replies, and sometimes writes first (urgent Messages, Check-ins).

Nothing here was run, sent or registered. Claims from a search excerpt, or that a fetched page did not state, are marked **unverified**. Meta moved its docs from `/docs/whatsapp/...` to `/documentation/business-messaging/whatsapp/...`; some old URLs redirect.

---

## Summary

1. **WhatsApp is free to test and nearly free to run for one owner.** A Meta developer app, a business portfolio and the auto-created test number; no payment method is needed to send template messages from a test number [W4]. Business verification is not mentioned as required to start [W2]. Replies inside the 24-hour window are free-form and free up to 1,000 a month per number [W1].
2. **Bot-first on WhatsApp is feasible**, two ways: (a) free-form while the owner's last message is under 24 hours old; (b) an approved **utility template** after that. Templates are reviewed automatically, "up to 24 hours" [W5]. A template is fixed text with variables, so a Check-in becomes a short nudge ("Update from your Bot: {{1}}") and the owner's reply opens the window for the rest.
3. **SMS on a Telnyx trial works for one number only**: $5 credit, one verified phone, 100 messages a day, long code only [T1]. That is exactly the owner's phone, so the lab loop fits. Whether trial texts to the verified number need 10DLC is **unverified**.
4. **Past the trial, US SMS needs 10DLC.** A hobbyist can register as a **Sole Proprietor** (no EIN): needs a US 10DLC number, a US/CA mobile for an OTP, name, address and date of birth; one campaign, one number; $4.50 brand + $15 vetting + $2 a month [T4][T6]. Not a fit outside US/Canada.
5. **Bot-first SMS is feasible** (no 24-hour window), but only after registration (or to the trial's verified number).
6. **Recommendation for the lab:** WhatsApp is the better first phone Channel (free tier, no carrier registration, documented test path). SMS is workable only inside the Telnyx trial or after a sole-proprietor registration, and only for a US/CA owner.

---

## 1. WhatsApp Cloud API

### 1.1 What the owner has to set up

| Step                                  | Detail                                                                                                                                                                                                                                                                                                                                                                | Source                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Accounts                              | A Facebook or managed Meta account, registered as a Meta developer                                                                                                                                                                                                                                                                                                    | [W2]                              |
| App                                   | Create an app; select or create a **business portfolio**                                                                                                                                                                                                                                                                                                              | [W2]                              |
| Business verification                 | Not mentioned as required in the get-started guide                                                                                                                                                                                                                                                                                                                    | [W2]                              |
| Test number                           | Get Started auto-creates a test WhatsApp account, Messaging account and test business phone number; test numbers have "relaxed messaging limits" and need no payment method to send template messages                                                                                                                                                                 | [W4]                              |
| Test recipient                        | Add the "To" number in the dashboard and send. **Unverified:** the earlier note says "5 verified recipients"; the current pages fetched do not state a cap                                                                                                                                                                                                            | [W2][W4]                          |
| Token                                 | The quickstart token "expires quickly" (duration not given); create a **system user** and a permanent token for development                                                                                                                                                                                                                                           | [W2]                              |
| Webhook                               | Inbound only by webhook, so a tunnel (ngrok, cloudflared) for local runs                                                                                                                                                                                                                                                                                              | `messaging-channel-apis.md`, [W3] |
| Own number (to leave the test number) | Must not already be on the WhatsApp app (delete it there first), be owned by you, have a country and area code, and receive an SMS or voice OTP. Mobile recommended; landline and VoIP work via voice OTP. Then Request Code, Verify Code, and the register endpoint. A display name is required and reviewed (`name_status`). A new portfolio can register 2 numbers | [W6]                              |
| Payment method                        | Meta says a payment method must be on file (by 2026-09-30) to avoid service disruption once free service messages are metered                                                                                                                                                                                                                                         | [W1]                              |

The practical cost of a real number: the owner needs a spare number that is **not their personal WhatsApp number**, because a number can't be on the WhatsApp app and the Cloud API at once [W6]. The test number avoids this. Since the Bot only talks to the owner, the test number may be enough for the whole lab (limits: the unverified recipient cap and an unknown test-number lifetime).

### 1.2 The 24-hour customer service window

- Opens when the user messages or calls the business; each new user message resets it to 24 hours [W1][W7].
- While open, any free-form (service) message type can be sent with no pre-approval [W7].
- After it closes only pre-approved template messages can be sent [W7].
- Messages may go only to users who opted in [W7]. For a Bot messaging its own owner, the owner starting the chat is the natural opt-in; whether Meta wants more is **unverified**.
- The error code for a send outside the window (131047) was not on the pages read: **unverified**.

### 1.3 Templates (Bot-first outside the window)

- Three categories: **authentication, marketing, utility**; the category drives price [W5].
- Created in WhatsApp Manager or via the Message Templates API (`name`, `category`, `language`, `parameter_format`, `components`) [W5].
- Reviewed automatically on create or edit; status `APPROVED` is required to send; "review can take up to 24 hours" [W5]. Rejected, paused or disabled templates can't be sent; templates can be paused for low read rates or negative feedback [W5].
- Limits: 100 templates created per hour; 250 templates per Messaging account while the portfolio is unverified [W5].
- Business-initiated sends outside windows are capped by the **messaging limit**: a new portfolio starts at **250 unique users per rolling 24 hours**; 2,000 after business verification or after 2,000 delivered template messages in 30 days [W8]. One owner is one unique user, so 250 is not a constraint.
- Whether Meta classifies a Check-in as **utility** or reclassifies it as **marketing** is up to the automated review; the re-classification rules are in a separate guide not read: **unverified**. Neutral transactional wording is the safe approach.

### 1.4 Cost

- Since 2025-07-01 pricing is per delivered message by category [W1].
- Free service messages: **1,000 per business phone number per month**, no rollover; metering past that began **2026-10-01** [W1].
- User-to-business messages are not charged [W1].
- **Utility templates inside an open window are charged from 2026-10-01**; they are free only inside a free-entry-point window (from a Click-to-WhatsApp ad, not relevant to a lab) [W1].
- The per-message rate card by country was not read: **unverified**. At a few messages a day, the free 1,000 covers free-form replies; occasional template sends cost cents.

### 1.5 Local testing

Webhook-only inbound needs a public HTTPS URL, so a tunnel. No WhatsApp emulator was found in the docs read. Sandbox accounts (valid 30 days) are described for Embedded Signup partners [W9]; whether a plain developer can use one is **unverified**.

---

## 2. SMS on Telnyx

### 2.1 Trial

From the Telnyx trial page [T1]:

- **$5 credit**; one verified number (10 changes and 15 delivery attempts per account lifetime); one local number in the account's country, reclaimed within 30 days if the account does not upgrade; credit cards only; one API key.
- Messaging: one profile; **long code only; outbound only to the verified number, 100 per day; inbound only from the verified number**.
- The trial page does not mention 10DLC or toll-free. The send-message guide says two Telnyx numbers can message each other without registration, and that off-net sends "generally require" sender registration, else HTTP 403 code 40301 [T2]. So whether the trial's number-to-verified-phone loop succeeds unregistered is **unverified**.
- A search excerpt mentioned a tighter "pretrial" tier (10 messages a day): **unverified**.

For a lab where the owner texts their own Bot, the trial restrictions are the owner's own number, not a handicap.

### 2.2 US 10DLC for a hobbyist

10DLC registers through The Campaign Registry (TCR): brand, vetting, campaign, number assignment [T3]. Sole Proprietor is the path for "individuals and small businesses without a federal Tax ID (EIN)" [T4].

| Item        | Value                                                                                                                                    | Source   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Eligibility | At least one US 10DLC number; a valid US or CA mobile number for the OTP; name, address, date of birth. No government ID mentioned       | [T4]     |
| Flow        | Create brand (`SOLE_PROPRIETOR`, PENDING); trigger SMS OTP; submit PIN within 24 hours; brand becomes VERIFIED; then create a campaign   | [T4]     |
| Limits      | 1 campaign per brand; 1 number per campaign; max 3 brands per mobile number; low-volume throughput                                       | [T4]     |
| Throughput  | AT&T 15 SMS/min and 50 MMS/min; T-Mobile 1,000 a day; Verizon content filtering. **Unverified** (search excerpt of [T5])                 | [T5]     |
| Fees        | Brand $4.50 one-time (charged after verification); campaign vetting $15 per submission; $2 a month                                       | [T4][T6] |
| Time        | Standard brand vetting 1-7 business days [T3]; the sender-type table says 2-3 business days [T7]; sole-proprietor review time not stated | [T3][T7] |
| Allowed use | Page names only the SOLE_PROPRIETOR use case (example: appointment reminders); no full list                                              | [T4]     |

Without registration, "US long codes ... will experience carrier filtering and potential message blocking" (per the earlier Telnyx note). That note said "$4 brand"; the current pages say **$4.50** and give the monthly fee ($2 sole proprietor) [T6].

### 2.3 Alternatives

- **Toll-free (US/Canada):** toll-free verification, 2-3 business days, about $2 a month [T7]. Verification now requires business registration fields (number, type, country) and unverified numbers get low throughput and filtering [T8]. No individual track was found, so a hobbyist may be blocked: **unverified**.
- **Short code:** 2-6 weeks, about $500-1,000 a month [T7]. Out.
- **Alphanumeric sender ID:** 100+ countries, instant, but **one-way** and **not allowed to US/Canada/Puerto Rico** [T7][T9]. It can't receive replies, so at most an alert-only path outside the US.
- **Non-US owner:** rules are per country; several need business documents (India DLT, Australia ACMA, Singapore SSIR, Norway, Turkey) [T9]. Telnyx non-US pricing is by destination and not on the pricing page, which points at `GET /v2/public/pricing?primitive=sms` [T10]. Number availability and the trial number's country rules were **not researched**. For a non-US owner SMS is least attractive and WhatsApp most.

### 2.4 Cost (US)

Local number SMS $0.004 per part out and in, plus carrier fee (AT&T $0.0035, T-Mobile and Verizon $0.0045 out); toll-free $0.0055; number about $1 a month [T10]. At a few texts a day this is cents plus the $2 sole-proprietor monthly fee; the one-time registration total is about $19.50.

### 2.5 Local testing

Webhook in (tunnel), `POST /v2/messages` out. Two Telnyx numbers can text each other with no registration [T2], giving a carrier-free loop only if the owner can hold a second number (the trial allows one: **unverified** whether a second can be bought).

---

## 3. Can the Bot start the conversation?

|                                                   | WhatsApp                                                                                                           | SMS (Telnyx)                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Reply to the owner                                | Free-form inside 24 h of the owner's last message                                                                  | Any time                                                                             |
| Bot-first within 24 h of the owner's last message | Free-form, free in the 1,000 tier                                                                                  | Any time                                                                             |
| Bot-first after that                              | **Approved utility template** (about 24 h review); fixed text with variables; the owner's reply reopens the window | No window; allowed once the sender is registered (or to the trial's verified number) |
| Blocker                                           | Template review outcome; classification as marketing                                                               | 10DLC sole-proprietor registration; content filtering                                |
| Verdict                                           | **Feasible**                                                                                                       | **Feasible for a US/CA owner after registration**; trial-only for the bare lab loop  |

Design consequences (for the spec, not decided here):

1. A WhatsApp adapter needs to know whether the window is open: record the owner's last inbound time per Channel and choose free-form or the template at send time. If the template is missing or unapproved, surface the Message on another Channel rather than lose it.
2. Urgent Messages are the case that most needs the template; Check-ins usually follow an owner message and often fall inside the window.
3. SMS needs no window logic, but each Message is a billable part, and an unregistered sender is silently filtered, which looks like a Bot that did not send.

---

## 4. What the owner concretely does

### WhatsApp (recommended first)

1. Register as a Meta developer; create an app and a business portfolio (free).
2. Add the WhatsApp product; note the test phone number ID and Messaging account ID; add the owner's phone as the "To" number and send the sample message.
3. Create a system user and a permanent token; store it as a secret.
4. Start a tunnel; set the webhook URL and verify token; subscribe to message events.
5. Message the test number from the owner's phone (opens the window); the Bot replies free-form.
6. For Bot-first outside the window: create one **utility** template (for example "Update from your Bot: {{1}}") in WhatsApp Manager and wait up to 24 hours for approval.
7. Add a payment method so metering from 2026-10-01 does not disrupt service [W1].
8. Only if the test number proves too limiting: bring a spare number not on WhatsApp, verify by SMS or voice OTP, pick a display name, register it.

Expected cost: zero for the lab; cents if template sends are metered.

### SMS (US/CA owner only)

1. Create a Telnyx trial account (credit card) and verify the owner's phone as the one verified number.
2. Buy the one trial local number (reclaimed in 30 days unless the account is upgraded); create a messaging profile and assign the number.
3. Point the profile's webhook at a tunnel; text the number from the verified phone. Expect a possible 403 / 40301 if the carrier path needs 10DLC (unverified).
4. To keep it beyond the trial: upgrade the account, register a **Sole Proprietor** brand (name, address, DOB, US/CA mobile OTP), create the one campaign, assign the number. About $19.50 up front, $2 a month, a few business days.
5. Non-US owner, or anyone who can't register: skip Telnyx SMS and use WhatsApp.

---

## 5. Not verified

- WhatsApp test-number recipient cap (earlier note says 5; current docs do not say).
- Error code and behaviour for a send outside the window (131047); whether Meta needs a formal opt-in for the owner's own number.
- Template re-classification rules, the WhatsApp per-message rate card, token lifetime, test-number lifetime.
- Whether trial SMS to the verified number is delivered without 10DLC; sole-proprietor review time; sole-proprietor throughput figures (search excerpt only).
- Toll-free verification for an individual with no business registration.
- Non-US Telnyx trial and sender rules.
- TCR's own documents (campaignregistry.com) were not read; sole-proprietor facts come from Telnyx pages.

---

## Sources

- [W1] WhatsApp pricing: https://developers.facebook.com/docs/whatsapp/pricing
- [W2] Cloud API get started: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- [W3] Webhooks: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
- [W4] Get started (current path), via search result: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- [W5] Template fundamentals: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
- [W6] Business phone numbers: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers
- [W7] Send messages: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
- [W8] Messaging limits: https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
- [W9] Embedded Signup overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
- [T1] Telnyx trial limits: https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/trial
- [T2] Telnyx send a message: https://developers.telnyx.com/docs/messaging/messages/send-message
- [T3] Telnyx 10DLC quickstart: https://developers.telnyx.com/docs/messaging/10dlc/quickstart
- [T4] Telnyx sole proprietor: https://developers.telnyx.com/docs/messaging/10dlc/sole-proprietor
- [T5] Telnyx 10DLC rate limits (search excerpt only): https://developers.telnyx.com/docs/messaging/10dlc/10dlc-rate-limits
- [T6] Telnyx 10DLC fees: https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges
- [T7] Telnyx choosing a sender type: https://developers.telnyx.com/docs/messaging/getting-started/choosing-your-sender-type
- [T8] Telnyx toll-free verification (search excerpt): https://developers.telnyx.com/docs/messaging/toll-free-verification
- [T9] Telnyx alphanumeric sender ID and international compliance (search excerpts): https://developers.telnyx.com/docs/messaging/messages/alphanumeric-sender-id
- [T10] Telnyx messaging pricing: https://telnyx.com/pricing/messaging
