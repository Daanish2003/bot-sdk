// @vitest-environment jsdom
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { botClient } from "../../../plugins/bot/client/index";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const createdAt = new Date("2026-10-23T09:00:00.000Z");
const ada = { id: "b2", name: "Ada", model: "openai:gpt-6-luna", createdAt };
const fileId = (n: number) => `0199c8a0-0000-7000-8000-00000000000${n}`;

type Upload = { file: File; finish: (result: string | { code: string; params: object }) => void };

/**
 * A Conversation whose uploads wait until the test finishes each one. A send is refused with each
 * of `refusals`' data in turn, then saved.
 */
function mount({ refusals = [] }: { refusals?: { code: string; missing?: string[] }[] } = {}) {
  const uploads: Upload[] = [];
  const sends: { text: string; files?: string[] }[] = [];
  const router = {
    bots: {
      get: os.handler(() => ({ bot: { ...ada, turnStatus: null }, messages: [], turns: [] })),
      stop: os.handler(() => {}),
      send: os
        .input(
          z.object({
            botId: z.string(),
            id: z.string(),
            text: z.string(),
            files: z.array(z.string()).optional(),
          }),
        )
        .handler(({ input }) => {
          sends.push({ text: input.text, files: input.files });
          const refusal = refusals.shift();
          if (refusal) throw new ORPCError("BAD_REQUEST", { data: refusal });
          // The saved Message carries its files as the files control.
          const files = (input.files ?? []).map((id) => ({
            id,
            name: "a.txt",
            size: 5,
            mediaType: "text/plain",
          }));
          return {
            id: input.id,
            role: "user" as const,
            text: input.text,
            createdAt: new Date(),
            ...(files.length > 0 && { control: { kind: "files" as const, files } }),
          };
        }),
    },
    routines: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    checkIns: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    helpers: { list: os.input(z.object({ botId: z.string() })).handler(() => []) },
    secrets: { list: os.handler(() => []) },
  };
  const handler = new RPCHandler(router);
  // jsdom's File can't go through a multipart body, so an upload is answered here, when the test
  // finishes it, in the RPC wire format. The test's Nth attached file is the Nth request's.
  const attached: File[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify({ json: body, meta: [] }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetch = async (request: Request) => {
    if (request.url.endsWith("/bots/upload")) {
      const file = attached[uploads.length]!;
      return new Promise<Response>((resolve) => {
        uploads.push({
          file,
          finish: (result) =>
            resolve(
              typeof result !== "string"
                ? json(400, {
                    defined: false,
                    code: "BAD_REQUEST",
                    status: 400,
                    message: "refused",
                    data: result,
                  })
                : json(200, {
                    id: result,
                    name: file.name,
                    size: file.size,
                    mediaType: "text/plain",
                  }),
            ),
        });
      });
    }
    return (
      (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
      new Response(null, { status: 404 })
    );
  };
  const view = render(
    providerFor(createElement(BotConversation, { botId: ada.id }), {
      fetch,
      messages: {},
      plugins: [botClient()],
    }),
  );
  const { container } = view;
  return {
    container,
    uploads,
    attached,
    sends,
    attach: async (...files: File[]) => {
      await waitFor(() => expect(container.querySelector("[data-attach-input]")).not.toBeNull());
      attached.push(...files);
      fireEvent.change(container.querySelector("[data-attach-input]")!, { target: { files } });
    },
    chips: () => [
      ...container.querySelectorAll<HTMLElement>("[data-draft-files] [data-slot=attachment]"),
    ],
    send: () => container.querySelector<HTMLButtonElement>("button[type=submit]")!,
  };
}

const file = (name: string, size = 5) => new File(["x".repeat(size)], name, { type: "text/plain" });

describe("the Bot composer's attachments", () => {
  it("shows a chip with its progress per file, and a remove button takes it away", async () => {
    const view = mount();
    await view.attach(file("notes.txt"));

    await waitFor(() => expect(view.chips()).toHaveLength(1));
    expect(view.chips()[0]!.dataset.state).toBe("uploading");
    expect(view.chips()[0]!.textContent).toContain("notes.txt");
    await waitFor(() => expect(view.uploads).toHaveLength(1));
    view.uploads[0]!.finish(fileId(1));
    await waitFor(() => expect(view.chips()[0]!.dataset.state).toBe("done"));

    fireEvent.click(view.chips()[0]!.querySelector("button")!);
    expect(view.chips()).toHaveLength(0);
  });

  it("shows a refused file's error on its chip, and Send stays off until it is removed", async () => {
    const view = mount();
    await view.attach(file("big.bin"));
    await waitFor(() => expect(view.uploads).toHaveLength(1));
    view.uploads[0]!.finish({
      code: "error.botFileTooLarge",
      params: { name: "big.bin", max: 25 },
    });

    await waitFor(() => expect(view.chips()[0]!.dataset.state).toBe("error"));
    expect(view.chips()[0]!.textContent).toContain("larger than 25 MB");
    expect(view.send().disabled).toBe(true);
    fireEvent.click(view.chips()[0]!.querySelector("button")!);
    expect(view.chips()).toHaveLength(0);
  });

  it("refuses an eleventh file on its chip without uploading it", async () => {
    const view = mount();
    await view.attach(...Array.from({ length: 11 }, (_, n) => file(`f${n}.txt`)));

    await waitFor(() => expect(view.chips()).toHaveLength(11));
    expect(view.chips()[10]!.dataset.state).toBe("error");
    expect(view.chips()[10]!.textContent).toContain("at most 10 files");
    expect(view.uploads.filter((upload) => upload.file.name === "f10.txt")).toHaveLength(0);
  });

  it("makes Send wait for the uploads, then sends their ids with the text", async () => {
    const view = mount();
    await view.attach(file("a.txt"), file("b.txt"));
    await waitFor(() => expect(view.uploads).toHaveLength(2));
    fireEvent.change(view.container.querySelector("textarea")!, {
      target: { value: "read these" },
    });

    expect(view.send().disabled).toBe(true);
    view.uploads[0]!.finish(fileId(1));
    await waitFor(() => expect(view.chips()[0]!.dataset.state).toBe("done"));
    expect(view.send().disabled).toBe(true);
    view.uploads[1]!.finish(fileId(2));
    await waitFor(() => expect(view.send().disabled).toBe(false));

    fireEvent.click(view.send());
    await waitFor(() => expect(view.sends).toHaveLength(1));
    expect(view.sends[0]).toEqual({ text: "read these", files: [fileId(1), fileId(2)] });
    expect(view.chips()).toHaveLength(0);
    // The user's Message shows the same files card a Bot uses.
    await waitFor(() =>
      expect(view.container.querySelectorAll(`[data-files-card] a[data-file]`)).toHaveLength(2),
    );
  });

  it("sends files with no text", async () => {
    const view = mount();
    await view.attach(file("a.txt"));
    await waitFor(() => expect(view.uploads).toHaveLength(1));
    view.uploads[0]!.finish(fileId(1));
    await waitFor(() => expect(view.send().disabled).toBe(false));

    fireEvent.click(view.send());
    await waitFor(() => expect(view.sends).toEqual([{ text: "", files: [fileId(1)] }]));
  });

  it("puts a refused send's files back, except the ones no longer uploaded", async () => {
    const view = mount({
      refusals: [
        { code: "error.modelNotAvailable" },
        { code: "error.botFileNotFound", missing: [fileId(1)] },
      ],
    });
    await view.attach(file("a.txt"), file("b.txt"));
    await waitFor(() => expect(view.uploads).toHaveLength(2));
    view.uploads[0]!.finish(fileId(1));
    view.uploads[1]!.finish(fileId(2));
    const textarea = view.container.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "read it" } });
    await waitFor(() => expect(view.send().disabled).toBe(false));

    // Any other refusal: the files are still uploaded, so they come back to send again.
    fireEvent.click(view.send());
    await waitFor(() => expect(view.sends).toHaveLength(1));
    await waitFor(() => expect(view.chips()).toHaveLength(2));
    expect(view.chips().map((chip) => chip.dataset.state)).toEqual(["done", "done"]);

    // Gone (swept, or taken by an earlier send): a resend would be refused again, so it doesn't.
    fireEvent.click(view.send());
    await waitFor(() => expect(view.sends).toHaveLength(2));
    // The refusal is handled once its text is back in the composer.
    await waitFor(() => expect(textarea.value).toBe("read it"));
    expect(view.chips()).toHaveLength(1);
    expect(view.chips()[0]!.textContent).toContain("b.txt");
  });

  it("takes files dropped on the thread", async () => {
    const view = mount();
    await waitFor(() => expect(view.container.querySelector("section")).not.toBeNull());
    const dropped = file("dropped.txt");
    view.attached.push(dropped);
    fireEvent.drop(view.container.querySelector("section")!, {
      dataTransfer: { types: ["Files"], files: [dropped] },
    });

    await waitFor(() => expect(view.chips()).toHaveLength(1));
    expect(view.chips()[0]!.textContent).toContain("dropped.txt");
  });
});
