// @vitest-environment jsdom
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { messageInfo } from "../../../core/client/chat";
import {
  type ConversationData,
  type ConversationRunOptions,
  useConversationRun,
} from "../../../core/client/react/conversation-run";
import type { ActiveBranchMessage } from "../../../core/shared/chat/client-message";
import type { TurnChange } from "../../../core/shared/memory/changes";
import { providerFor } from "../../ui/fake-dictionary";

/*
 * The client side of a Conversation's Runs, through the hook's interface. The Run's connection
 * (`POST` to send, `GET ?runId=` to join) goes to a stubbed global `fetch` that streams SSE chunks;
 * the RPC calls go to a fake oRPC router; the Memory events come from a fake `EventSource`.
 */

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const conversationId = "00000000-0000-4000-8000-000000000001";
const model = "anthropic:claude-haiku-4-5";

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  extra: Partial<ActiveBranchMessage> = {},
): ActiveBranchMessage {
  return {
    id,
    parentId: null,
    role,
    parts: [{ type: "text", content: text }],
    attachments: [],
    model: role === "assistant" ? model : null,
    reasoningEffort: null,
    status: "done",
    error: null,
    errorReason: null,
    usage: null,
    rating: null,
    contextStartId: null,
    hidden: false,
    createdAt: new Date("2026-10-15T00:00:00.000Z"),
    siblings: { index: 0, count: 1, previousId: null, nextId: null },
    memoryChanges: [],
    ...extra,
  } as ActiveBranchMessage;
}

function conversationWith(messages: ActiveBranchMessage[]): ConversationData {
  return {
    id: conversationId,
    title: "A chat",
    model,
    reasoningEffort: null,
    temporary: false,
    tools: { connections: [], allowedTools: [] },
    archivedAt: null,
    messages,
  } as unknown as ConversationData;
}

/** What the fake server holds and was asked. */
type Server = {
  /** The Conversation `conversation.get` returns. */
  conversation: ConversationData;
  stop: Procedure;
  rate: Procedure;
  decide: Procedure;
};

type Procedure = Mock<(input: unknown) => Promise<unknown>>;

let server: Server;

/** The chat procedures the hook calls, served by oRPC's own handler so the wire format is real. */
function rpcFetch() {
  const router = {
    conversation: { get: os.handler(() => server.conversation) },
    chat: {
      stop: os.handler(({ input }) => server.stop(input)),
      rate: os.handler(({ input }) => server.rate(input)),
      decide: os.handler(({ input }) => server.decide(input)),
    },
  };
  const handler = new RPCHandler(router);
  return async (request: Request) => {
    const { matched, response } = await handler.handle(request, { prefix: "/api/chat/rpc" });
    return matched ? response : new Response(null, { status: 404 });
  };
}

/** An SSE response carrying `chunks`, as the Run route streams them. */
function sse(chunks: object[]) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/** A Run's log: one assistant reply streamed as `deltas`, then any `extra` chunks. */
function replyChunks(runId: string, deltas: string[], extra: object[] = []) {
  const messageId = `${runId}-text`;
  return [
    { type: "RUN_STARTED", threadId: conversationId, runId, timestamp: 0 },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant", timestamp: 0 },
    ...deltas.map((delta) => ({ type: "TEXT_MESSAGE_CONTENT", messageId, delta, timestamp: 0 })),
    { type: "TEXT_MESSAGE_END", messageId, timestamp: 0 },
    ...extra,
    { type: "RUN_FINISHED", threadId: conversationId, runId, finishReason: "stop", timestamp: 0 },
  ];
}

/** Every request the Run's connection made, with its method, URL and JSON body. */
const runRequests: { method: string; url: string; body: unknown }[] = [];

/** Stubs the Run's connection: each request gets what `respond` returns. */
function stubRun(
  respond: (request: { method: string; url: string }) => Response | Promise<Response>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = {
        method: init?.method ?? "GET",
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      runRequests.push(request);
      return respond(request);
    }),
  );
}

/** The fake `EventSource`s opened, so a test can send a Memory event down one. */
class FakeEventSource {
  static opened: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  runRequests.length = 0;
  FakeEventSource.opened = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastError.mockReset();
});

/** Mounts the hook on `conversation`; `procedures` replace the fake server's defaults. */
function renderRun(
  conversation: ConversationData,
  options: Pick<Partial<ConversationRunOptions>, "connections" | "webSearchAvailable"> = {},
  procedures: Partial<Server> = {},
) {
  const ok = () => vi.fn(async (_input: unknown): Promise<unknown> => ({}));
  server = { conversation, stop: ok(), rate: ok(), decide: ok(), ...procedures };
  const callbacks = {
    onDecided: vi.fn<(conversation: ConversationData) => void>(),
    onSynced: vi.fn<(conversation: ConversationData) => void>(),
    onRefusedSend: vi.fn<(text: string) => void>(),
  };
  const wrapper = ({ children }: { children: ReactNode }) =>
    providerFor(children as never, { messages: {}, fetch: rpcFetch() });
  const hook = renderHook(
    () =>
      useConversationRun(conversation, {
        ...callbacks,
        webSearchAvailable: false,
        connections: [],
        ...options,
      }),
    { wrapper },
  );
  return { ...hook, callbacks };
}

/** The text of each Message the hook shows. */
function texts(messages: { parts: unknown[] }[]) {
  return messages.map((m) =>
    m.parts.map((part) => (part as { content?: string }).content ?? "").join(""),
  );
}

const question = message("u1", "user", "Hi");
const answer = message("a1", "assistant", "Hello", { parentId: "u1" });

describe("useConversationRun", () => {
  it("sends a Message: posts the command, streams the reply, then shows the refetched Branch", async () => {
    const after = [
      question,
      answer,
      message("u2", "user", "How are you?", { parentId: "a1" }),
      message("a2", "assistant", "Fine, thanks", { parentId: "u2" }),
    ];
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    stubRun(async () => {
      await released;
      return sse(replyChunks("r1", ["Fine, ", "thanks"]));
    });
    const { result } = renderRun(conversationWith([question, answer]), {
      connections: ["github"],
    });
    server.conversation = conversationWith(after);

    let sent!: Promise<void>;
    act(() => {
      sent = result.current.send("How are you?");
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    release();
    await act(() => sent);

    expect(runRequests).toHaveLength(1);
    expect(runRequests[0]).toMatchObject({
      method: "POST",
      body: {
        forwardedProps: {
          conversationId,
          parentId: "a1",
          text: "How are you?",
          attachmentIds: [],
          model,
          webSearch: false,
          tools: { connections: ["github"], allowedTools: [] },
        },
      },
    });
    expect(texts(result.current.messages)).toEqual(["Hi", "Hello", "How are you?", "Fine, thanks"]);
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(result.current.sending).toBe(false);
  });

  it("joins a reply streaming when the page opens, and hands on the refetched Conversation when it ends", async () => {
    const streaming = message("a1", "assistant", "", { parentId: "u1", status: "streaming" });
    stubRun(() => sse(replyChunks("a1", ["Hel", "lo"])));
    const finished = conversationWith([question, answer]);
    const { result, callbacks } = renderRun(conversationWith([question, streaming]));
    server.conversation = finished;

    expect(result.current.streaming).toBe(true);
    await waitFor(() => expect(callbacks.onSynced).toHaveBeenCalledOnce());

    expect(runRequests[0]?.method).toBe("GET");
    expect(new URL(runRequests[0]!.url).searchParams.get("runId")).toBe("a1");
    expect(callbacks.onSynced.mock.calls[0]?.[0]).toMatchObject({
      messages: [{ id: "u1" }, { id: "a1", status: "done" }],
    });
  });

  it("hides a joined reply whose log ends with `moderated`", async () => {
    const streaming = message("a1", "assistant", "", { parentId: "u1", status: "streaming" });
    stubRun(() =>
      sse(replyChunks("a1", ["Some ", "text"], [{ type: "CUSTOM", name: "moderated", value: {} }])),
    );
    const { result, callbacks } = renderRun(conversationWith([question, streaming]));
    server.conversation = conversationWith([question, streaming]);

    await waitFor(() => expect(callbacks.onSynced).toHaveBeenCalled());

    const reply = result.current.messages.at(-1)!;
    expect(reply.role).toBe("assistant");
    expect(reply.parts).toEqual([]);
    expect(messageInfo(reply).hidden).toBe(true);
  });

  it("stops the Run streaming on the Active Branch, by the server's Message id", async () => {
    // The page sent this reply, so `useChat` only knows its own id; the server's comes from a refetch.
    stubRun(() => new Promise<Response>(() => {}));
    const { result } = renderRun(conversationWith([question, answer]));
    server.conversation = conversationWith([
      question,
      answer,
      message("u2", "user", "More", { parentId: "a1" }),
      message("a2", "assistant", "", { parentId: "u2", status: "streaming" }),
    ]);

    act(() => void result.current.send("More"));
    await act(() => result.current.stop());

    expect(server.stop).toHaveBeenCalledWith({ messageId: "a2" });
  });

  it("keeps a moderated refusal and hands the composer's text back", async () => {
    stubRun(() =>
      Response.json(
        { message: "Blocked", code: "moderated", reason: "Off-policy request" },
        { status: 422 },
      ),
    );
    const { result, callbacks } = renderRun(conversationWith([question, answer]));

    await act(() => result.current.send("How do I pick a lock?"));

    expect(result.current.refusal?.message).toBe("Off-policy request");
    expect(callbacks.onRefusedSend).toHaveBeenCalledWith("How do I pick a lock?");
  });

  it("does not hand an edit's refused text to the composer", async () => {
    stubRun(() => Response.json({ message: "Blocked", code: "moderated" }, { status: 422 }));
    const { result, callbacks } = renderRun(conversationWith([question, answer]));

    await act(() => result.current.edit("u1", "Something else"));

    expect(result.current.refusal).not.toBeNull();
    expect(callbacks.onRefusedSend).not.toHaveBeenCalled();
  });

  it("decides an Approval, then hands on the refetched Conversation", async () => {
    const waitingReply = message("a1", "assistant", "", {
      parentId: "u1",
      status: "awaiting_approval",
    });
    const { result, callbacks } = renderRun(conversationWith([question, waitingReply]));
    const resumed = conversationWith([
      question,
      message("a1", "assistant", "", { parentId: "u1", status: "streaming" }),
    ]);
    server.conversation = resumed;

    expect(result.current.waiting).toBe(true);
    await act(() => result.current.decide("a1", true, true));

    expect(server.decide).toHaveBeenCalledWith({
      messageId: "a1",
      approved: true,
      allowForConversation: true,
      webSearch: false,
    });
    expect(callbacks.onDecided).toHaveBeenCalledOnce();
    expect(callbacks.onDecided.mock.calls[0]?.[0]).toMatchObject({
      messages: [{ id: "u1" }, { id: "a1", status: "streaming" }],
    });
  });

  it("decides with the user's web search choice, as a send does", async () => {
    const waitingReply = message("a1", "assistant", "", {
      parentId: "u1",
      status: "awaiting_approval",
    });
    const { result } = renderRun(conversationWith([question, waitingReply]), {
      webSearchAvailable: true,
    });

    await act(() => result.current.decide("a1", true));

    expect(server.decide).toHaveBeenCalledWith(expect.objectContaining({ webSearch: true }));
  });

  it("shows a refused decision as a toast and keeps the page as it was", async () => {
    const waitingReply = message("a1", "assistant", "", {
      parentId: "u1",
      status: "awaiting_approval",
    });
    const decide = vi.fn(async (_input: unknown): Promise<unknown> => {
      throw new ORPCError("CONFLICT", { message: "Already decided" });
    });
    const { result, callbacks } = renderRun(
      conversationWith([question, waitingReply]),
      {},
      { decide },
    );

    await act(() => result.current.decide("a1", false));

    expect(callbacks.onDecided).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledOnce();
  });

  it("shows a Rating at once and takes it back when the server refuses it", async () => {
    let refuse!: (error: Error) => void;
    const rate = vi.fn(
      (_input: unknown) =>
        new Promise<unknown>((_, reject) => {
          refuse = reject;
        }),
    );
    const rated = message("a1", "assistant", "Hello", { parentId: "u1", rating: "down" });
    const { result } = renderRun(conversationWith([question, rated]), {}, { rate });

    act(() => result.current.rate("a1", "up"));
    expect(messageInfo(result.current.messages[1]!).rating).toBe("up");
    await waitFor(() =>
      expect(server.rate).toHaveBeenCalledWith({ messageId: "a1", rating: "up" }),
    );

    await act(async () => refuse(new ORPCError("FORBIDDEN", { message: "No" })));

    await waitFor(() => expect(messageInfo(result.current.messages[1]!).rating).toBe("down"));
    expect(toastError).toHaveBeenCalledOnce();
  });

  it("adds a Memory event's changes to its reply", () => {
    const changes: TurnChange[] = [{ kind: "added", memoryId: "m1", text: "Is vegetarian" }];
    const { result, unmount } = renderRun(conversationWith([question, answer]));

    const [source] = FakeEventSource.opened;
    expect(source?.url).toBe(`http://localhost/api/chat/events?conversationId=${conversationId}`);
    act(() => source!.emit({ type: "memory_updated", messageId: "a1", changes }));

    expect(messageInfo(result.current.messages[1]!).memoryChanges).toEqual(changes);
    expect(messageInfo(result.current.messages[0]!).memoryChanges).toEqual([]);
    unmount();
    expect(source!.closed).toBe(true);
  });
});
