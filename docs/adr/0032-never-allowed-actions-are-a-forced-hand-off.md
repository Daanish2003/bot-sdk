---
Status: accepted
---

# Never-allowed actions are a hand-off no rule or Approval can change

Decided in [Never-allowed action classes](https://github.com/Daanish2003/bot-sdk/issues/986), on the [Approval rules](https://github.com/Daanish2003/bot-sdk/issues/973) map. Builds on ADR 0031 (Custom Rules).

Some actions a Bot never takes, whatever the user's rules or Approvals say. Such a call is blocked with no Approval offered, and the Bot is told the user must do it themselves and not to try another way. It is the hand-off mode of a Custom Rule, made permanent.

The SDK's list:

1. Moving money between accounts, or trading securities or crypto. Purchases are not on it: they need an Approval (the Payments map).
2. Acting on someone else's account, or signing in as someone else.
3. Changing the sign-in security of any of the user's accounts: passwords, two-factor and recovery settings.
4. Sending a Secret's value, or card or government ID numbers, anywhere off the Computer.
5. Weakening the Bot's own safety: changing Custom Rules, answering an Approval or turning off Auto-review, other than by proposing a rule for the user's Approval.

A Host can add classes of its own, in plain language in its configuration, but can't remove the SDK's. A user can't change the list.

Auto-review recognizes these classes, since they are about meaning ("a bank's transfer page", "a password field"). Its verdict gains a third outcome, `never`, beside pass and block, and it is shown the list for every call it reviews. Where code can tell for certain, as with the Approval and Custom Rule tools, code enforces it too. The review is listed as never allowed, with no Approval control.

## Considered Options

- **Refuse outright** (Duet), a fifth outcome beside the four modes. To the user, "the Bot won't" and "you do it" are the same, so one hand-off outcome is enough.
- **Hand-off defaults the user can loosen** (dots treats password changes this way): a rule written in a hurry could open a bank transfer to a prompt-injected page.
- **Let the user change the list**: what makes these actions safe is that nothing the Bot reads can reach them, and a user's setting is one more thing to talk them into.

## Consequences

- A `never` verdict is a model's judgment, so it can miss. Evals cover each class.
- Payments (build item 11) must keep purchases apart from moving money: a purchase goes to an Approval, and a transfer is never allowed.
