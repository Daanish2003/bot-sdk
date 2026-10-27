// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { knowledgeClient } from "@botsdk/knowledge/client";
import type { KnowledgeListing } from "@botsdk/knowledge/server/files";
import { KnowledgePopover } from "../../src/knowledge/knowledge-popover";
import { providerFor, type TestClient } from "@ai-chat/test-support/fake-dictionary";

afterEach(() => {
  cleanup();
});

const features = [knowledgeClient()];
const mib = 1024 * 1024;

const listing: KnowledgeListing = {
  files: [
    { path: "clients/acme.txt", size: 2048, savedBy: "user" },
    { path: "clients/report.md", size: 5 * mib, savedBy: "bot" },
    { path: "handbook.md", size: 26 * mib, savedBy: "user" },
  ],
  folders: ["clients"],
  usage: 31 * mib + 2048,
  limit: 50 * mib,
};

/** A fetch that records each request's path and body, and answers with `answer`. */
function recordingFetch(
  answer: (url: string) => Response | Promise<Response> = () => new Response(),
) {
  const calls: { url: string; body: string }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    // A file goes up as multipart, whose body the jsdom Request can't re-read; the call is recorded by its URL.
    const multipart = request.headers.get("content-type")?.startsWith("multipart/") ?? false;
    calls.push({ url: request.url, body: multipart ? "" : await request.clone().text() });
    return answer(request.url);
  });
  return { fetch, calls };
}

const pending = () => new Promise<Response>(() => {});
const calledWith = (calls: { url: string; body: string }[], procedure: string) =>
  calls.find((call) => new URL(call.url).pathname.endsWith(`knowledge/${procedure}`));

/** Seeds the status, and the list unless `shown` is null (the list still loading). */
function seeded(available = true, shown: KnowledgeListing | null = listing) {
  return (queryClient: QueryClient, client: TestClient) => {
    queryClient.setQueryData(client.orpc.knowledge.status.queryKey(), { available });
    if (shown) queryClient.setQueryData(client.orpc.knowledge.list.queryKey(), shown);
    // A list still loading that fails shows its failure at once, without the default retries.
    else queryClient.setDefaultOptions({ queries: { retry: false } });
  };
}

function renderPopover(
  fetch = recordingFetch(pending).fetch,
  available = true,
  shown: KnowledgeListing | null = listing,
) {
  render(
    providerFor(createElement(KnowledgePopover), {
      seed: seeded(available, shown),
      fetch,
      messages: {},
      features,
    }),
  );
  const button = screen.queryByRole("button", { name: /^Knowledge/ });
  if (button) fireEvent.click(button);
}

const textFile = (name: string, content = "hello") => new File([content], name);

const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;

describe("KnowledgePopover", () => {
  it("lists the tree: a count, 'Shared by all your Bots', folders, sizes and who saved each", () => {
    renderPopover();

    expect(screen.getByRole("button", { name: "Knowledge 3" })).toBeTruthy();
    expect(screen.getByText("Shared by all your Bots")).toBeTruthy();
    expect(screen.getByRole("button", { name: /clients/ })).toBeTruthy();
    const acme = screen.getByText("acme.txt").closest("li")!;
    expect(within(acme).getByText("2 KB")).toBeTruthy();
    expect(within(acme).getByText("you")).toBeTruthy();
    const report = screen.getByText("report.md").closest("li")!;
    expect(within(report).getByText("5 MB")).toBeTruthy();
    expect(within(report).getByText("a Bot")).toBeTruthy();
  });

  it("shows the usage meter", () => {
    renderPopover();

    expect(screen.getByText("31 MB of 50 MB")).toBeTruthy();
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe(String(listing.usage));
    expect(meter.getAttribute("aria-valuemax")).toBe(String(listing.limit));
  });

  it("has no Knowledge button without the computer plugin", () => {
    renderPopover(recordingFetch(pending).fetch, false);

    expect(screen.queryByRole("button", { name: /^Knowledge/ })).toBeNull();
  });

  it("shows Uploading… then Waking your Computer… while a file goes up", async () => {
    const { fetch, calls } = recordingFetch(pending);
    renderPopover(fetch);

    fireEvent.change(fileInput(), { target: { files: [textFile("new.md")] } });

    expect(await screen.findByText("Waking your Computer…")).toBeTruthy();
    await waitFor(() => expect(calledWith(calls, "upload")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "upload")!.body).json).toEqual({
      name: "new.md",
      content: "hello",
      folder: "",
    });
  });

  it("uploads into the selected folder", async () => {
    const { fetch, calls } = recordingFetch(pending);
    renderPopover(fetch);

    fireEvent.click(screen.getByRole("button", { name: /clients/ }));
    expect(screen.getByRole("button", { name: "Upload into clients" })).toBeTruthy();
    fireEvent.change(fileInput(), { target: { files: [textFile("new.md")] } });

    await waitFor(() => expect(calledWith(calls, "upload")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "upload")!.body).json).toMatchObject({
      folder: "clients",
      name: "new.md",
    });
  });

  it("shows a refusal's reason with 'Nothing was added', and dismisses it", async () => {
    const refusal = () =>
      Response.json(
        {
          json: {
            defined: false,
            code: "BAD_REQUEST",
            status: 400,
            message: "Knowledge is full",
            data: { code: "error.knowledgeFull" },
          },
        },
        { status: 400 },
      );
    renderPopover(recordingFetch(refusal).fetch);

    fireEvent.change(fileInput(), { target: { files: [textFile("more.md")] } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Knowledge is full: it holds at most 50 MB");
    expect(alert.textContent).toContain("Nothing was added.");
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks 'Replace?' for a name already in the folder, and replaces only when confirmed", async () => {
    const { fetch, calls } = recordingFetch(pending);
    renderPopover(fetch);

    fireEvent.change(fileInput(), { target: { files: [textFile("handbook.md", "v2")] } });

    expect(await screen.findByText("Replace “handbook.md”?")).toBeTruthy();
    expect(calledWith(calls, "upload")).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Replace “handbook.md”?")).toBeNull();
    expect(calledWith(calls, "upload")).toBeUndefined();

    fireEvent.change(fileInput(), { target: { files: [textFile("handbook.md", "v2")] } });
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));

    await waitFor(() => expect(calledWith(calls, "upload")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "upload")!.body).json).toEqual({
      folder: "",
      name: "handbook.md",
      content: "v2",
      replace: true,
    });
  });

  it("deletes a file", async () => {
    const { fetch, calls } = recordingFetch(pending);
    renderPopover(fetch);

    const row = screen.getByText("acme.txt").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(calledWith(calls, "remove")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "remove")!.body).json).toEqual({
      path: "clients/acme.txt",
    });
  });

  it("makes a new folder inside the selected folder", async () => {
    const { fetch, calls } = recordingFetch(pending);
    renderPopover(fetch);

    fireEvent.click(screen.getByRole("button", { name: /clients/ }));
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
      target: { value: "acme" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(calledWith(calls, "createFolder")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "createFolder")!.body).json).toEqual({
      path: "clients/acme",
    });
  });

  it("shows Converting… while a PDF is converted, and sends it as a file", async () => {
    const { fetch, calls } = recordingFetch(pending);
    renderPopover(fetch);

    fireEvent.change(fileInput(), { target: { files: [new File(["%PDF"], "plan.pdf")] } });

    expect(await screen.findByText("Converting…")).toBeTruthy();
    await waitFor(() => expect(calledWith(calls, "uploadDocument")).toBeTruthy());
    expect(calledWith(calls, "upload")).toBeUndefined();
  });

  it("sends a file whose name only ends in the letters pdf as text", async () => {
    const { fetch, calls } = recordingFetch(pending);
    renderPopover(fetch);

    fireEvent.change(fileInput(), { target: { files: [textFile("mypdf")] } });

    await waitFor(() => expect(calledWith(calls, "upload")).toBeTruthy());
    expect(calledWith(calls, "uploadDocument")).toBeUndefined();
  });

  it("refuses a text file that isn't UTF-8 with 'Nothing was added', and sends nothing", async () => {
    const { fetch, calls } = recordingFetch(pending);
    renderPopover(fetch);

    fireEvent.change(fileInput(), {
      target: { files: [new File([new Uint8Array([0x68, 0xff, 0xfe])], "latin.txt")] },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('"latin.txt" isn\'t a UTF-8 text file');
    expect(alert.textContent).toContain("Nothing was added.");
    expect(calledWith(calls, "upload")).toBeUndefined();
  });

  it("refuses a text file that isn't UTF-8 before asking Replace?", async () => {
    renderPopover();

    fireEvent.change(fileInput(), {
      target: { files: [new File([new Uint8Array([0xff])], "handbook.md")] },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("isn't a UTF-8 text file");
    expect(screen.queryByText("Replace “handbook.md”?")).toBeNull();
  });

  it("keeps files dropped while the list is still loading, and sends them once it loads", async () => {
    let answerList: (response: Response) => void = () => {};
    const { fetch, calls } = recordingFetch((url) =>
      new URL(url).pathname.endsWith("knowledge/list")
        ? new Promise<Response>((resolve) => (answerList = resolve))
        : pending(),
    );
    renderPopover(fetch, true, null);

    const dropZone = screen.getByText("Markdown, text, HTML, CSV, DOCX or PDF").parentElement!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [textFile("early.md")] } });
    // Shown at once, while the list loads.
    const row = (await screen.findByText("early.md")).closest("li")!;
    expect(within(row).getByText("Uploading…")).toBeTruthy();
    await waitFor(() => expect(calledWith(calls, "list")).toBeTruthy());
    answerList(Response.json({ json: listing }));

    await waitFor(() => expect(calledWith(calls, "upload")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "upload")!.body).json).toMatchObject({ name: "early.md" });
  });

  it("shows a file dropped while the list can't load as refused", async () => {
    const refusal = () =>
      Response.json(
        {
          json: {
            defined: false,
            code: "BAD_REQUEST",
            status: 400,
            message: "x",
            data: { code: "error.knowledgeComputerUnavailable" },
          },
        },
        { status: 400 },
      );
    renderPopover(recordingFetch(refusal).fetch, true, null);

    const dropZone = screen.getByText("Markdown, text, HTML, CSV, DOCX or PDF").parentElement!;
    fireEvent.drop(dropZone, { dataTransfer: { files: [textFile("early.md")] } });

    const row = (await screen.findByText("early.md")).closest("li")!;
    expect(within(row).getByRole("alert").textContent).toContain("Nothing was added.");
  });

  it("shows a scanned PDF's refusal with 'Nothing was added'", async () => {
    const refusal = () =>
      Response.json(
        {
          json: {
            defined: false,
            code: "BAD_REQUEST",
            status: 400,
            message: "x",
            data: { code: "error.knowledgeNoText" },
          },
        },
        { status: 400 },
      );
    renderPopover(recordingFetch(refusal).fetch);

    fireEvent.change(fileInput(), { target: { files: [new File(["%PDF"], "scan.pdf")] } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This PDF has no text to read (it may be a scan)");
    expect(alert.textContent).toContain("Nothing was added.");
  });

  it("lists a PDF once and expands to its readable text, which isn't a row of its own", async () => {
    const withPdf: KnowledgeListing = {
      files: [
        { path: "handbook.pdf", size: 2048, savedBy: "user", readable: "handbook.pdf.md" },
        { path: "notes.md", size: 5, savedBy: "user" },
      ],
      folders: [],
      usage: 4096,
      limit: 50 * mib,
    };
    const { fetch, calls } = recordingFetch((url) =>
      new URL(url).pathname.endsWith("knowledge/read")
        ? Response.json({
            json: { path: "handbook.pdf.md", content: "## Page 1\nHello", size: 15 },
          })
        : pending(),
    );
    renderPopover(fetch, true, withPdf);

    expect(screen.queryByText("handbook.pdf.md")).toBeNull();
    expect(screen.queryByText("Readable text (what your Bots read)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show readable text" }));

    expect(await screen.findByText("Readable text (what your Bots read)")).toBeTruthy();
    expect(await screen.findByText(/## Page 1/)).toBeTruthy();
    expect(JSON.parse(calledWith(calls, "read")!.body).json).toEqual({ path: "handbook.pdf.md" });
    expect(screen.queryByRole("button", { name: "Show readable text" })).toBeNull();
    expect(
      within(screen.getByText("notes.md").closest("li")!).queryByRole("button", {
        name: /readable/,
      }),
    ).toBeNull();
  });
});
