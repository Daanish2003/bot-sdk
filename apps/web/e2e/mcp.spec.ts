import { expect, test } from "@playwright/test";

import { mcpMarker, mcpToolName } from "../../../packages/chat-sdk/test/e2e/fake-ollama";

import { messageRows, send, signInAsSeededUserWithModel } from "./helpers";

const server = "E2E Tracker";

test("a Connection signed in on the keys page, switched on, runs a tool call once approved", async ({
  page,
}) => {
  await signInAsSeededUserWithModel(page);

  // Connect from the keys page: the sign-in goes to the fake authorization server and back.
  await page.goto("/settings/keys");
  const connection = page.getByRole("listitem").filter({ hasText: server });
  await connection.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connection).toContainText("Connected");

  // The Tools menu is in a Conversation's composer, so the Conversation starts with a plain reply.
  await page.goto("/c");
  // The composer takes Enter only once the Model is picked, so wait for it.
  await expect(page.getByRole("button", { name: "Model" })).toContainText("e2e-model");
  await send(page, "Set up the tracker");
  await expect(page).toHaveURL(/\/c\/[\w-]+$/);

  // Switch the Connection on from the composer's Tools menu.
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const item = page.getByRole("menuitemcheckbox", { name: server });
  await item.click();
  await expect(item).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // The fake Model asks for the tool: the call waits for Approval, with its arguments shown.
  await page
    .getByLabel("Message", { exact: true })
    .fill(`${mcpMarker} Open an issue for the launch`);
  await page.keyboard.press("Enter");
  const reply = messageRows(page).last();
  await expect(reply).toContainText(mcpToolName);
  await expect(reply).toContainText("Waiting for approval");
  await expect(reply).toContainText("E2E launch");

  // Reloading finds the call still waiting.
  await page.reload();
  await expect(messageRows(page).last()).toContainText("Waiting for approval");
  await expect(messageRows(page).last()).toContainText(mcpToolName);

  // Approving runs the tool and the reply finishes with its result.
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(messageRows(page).last()).toContainText("The tool returned");
  await expect(messageRows(page).last()).toContainText("create_issue");
  // Approved, the tool ran: the Model got its result, not the refusal.
  await expect(messageRows(page).last()).not.toContainText("User declined");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});
