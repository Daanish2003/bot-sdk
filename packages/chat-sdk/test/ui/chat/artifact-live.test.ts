import type { UIMessage } from "@tanstack/ai-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  artifactCallsIn,
  liveArtifactOf,
  panelTargetOf,
  startedArtifactCalls,
} from "../../../ui/chat/artifact-live";
import { LiveArtifactView } from "../../../ui/chat/artifact-panel";

/** A streamed Artifact call on a Message, as `useChat` holds it while its arguments arrive. */
const callPart = (fields: Record<string, unknown> = {}) => ({
  type: "tool-call",
  id: "call-1",
  name: "create_artifact",
  arguments: "",
  state: "input-streaming",
  ...fields,
});

/** A Message `useChat` is streaming (no stored status yet) with the given parts. */
const streaming = (id: string, parts: unknown[]) =>
  ({ id, role: "assistant", parts }) as unknown as UIMessage;

/** A Message the server stored, which carries its own status. */
const stored = (id: string, parts: unknown[]) =>
  ({ id, role: "assistant", parts, metadata: { status: "complete" } }) as unknown as UIMessage;

const html = (args: string) => ({ kind: "html", title: "Landing page", content: args });

describe("the panel follows a streaming Artifact call", () => {
  it("opens on the first Artifact delta, and not again for later deltas", () => {
    const seen = new Set<string>();
    const first = streaming("m-1", [
      callPart({ arguments: '{"kind":"html","title":"Landing page","content":"<h1>Hel' }),
    ]);

    expect(startedArtifactCalls([first], seen).map((item) => item.call.id)).toEqual(["call-1"]);

    const later = streaming("m-1", [
      callPart({ arguments: '{"kind":"html","title":"Landing page","content":"<h1>Hello</h1>' }),
    ]);
    expect(startedArtifactCalls([later], seen)).toEqual([]);
  });

  it("still opens on a single-chunk call that arrives already complete and done", () => {
    const seen = new Set<string>();
    const message = streaming("m-1", [
      callPart({
        arguments: JSON.stringify(html("<h1>Hi</h1>")),
        input: html("<h1>Hi</h1>"),
        state: "complete",
        output: { artifactId: "a-1", version: 1 },
      }),
    ]);

    expect(startedArtifactCalls([message], seen).map((item) => item.call.id)).toEqual(["call-1"]);
    expect(panelTargetOf([message], { kind: "live", callId: "call-1" })).toEqual({
      kind: "saved",
      ref: { artifactId: "a-1", version: 1, messageId: "m-1" },
    });
  });

  it("ignores Artifact calls in Messages the server stored, and other tool calls", () => {
    const seen = new Set<string>();
    const messages = [
      stored("m-0", [callPart({ state: "complete", output: { artifactId: "a-1", version: 1 } })]),
      streaming("m-1", [callPart({ id: "call-2", name: "server_time" })]),
    ];

    expect(startedArtifactCalls(messages, seen)).toEqual([]);
    expect(artifactCallsIn(messages).map((item) => item.call.id)).toEqual(["call-1"]);
  });

  it("follows the call to its saved version on its Message once the call is done", () => {
    const messages = [
      streaming("m-1", [
        callPart({ state: "complete", output: { artifactId: "a-1", version: 1 } }),
      ]),
    ];

    expect(panelTargetOf(messages, { kind: "live", callId: "call-1" })).toEqual({
      kind: "saved",
      ref: { artifactId: "a-1", version: 1, messageId: "m-1" },
    });
  });

  it("stays on the live view while the call runs, and closes when no such call is on screen", () => {
    const running = [streaming("m-1", [callPart({ arguments: '{"kind":"html"' })])];

    expect(panelTargetOf(running, { kind: "live", callId: "call-1" })).toMatchObject({
      kind: "live",
    });
    expect(panelTargetOf(running, { kind: "live", callId: "missing" })).toBeNull();
  });
});

describe("the live source of a streaming Artifact", () => {
  it("shows the partial source growing as the arguments arrive in several deltas", () => {
    const early = streaming("m-1", [
      callPart({ arguments: '{"kind":"html","title":"Landing page","content":"<h1>Hel' }),
    ]);
    const later = streaming("m-1", [
      callPart({ arguments: '{"kind":"html","title":"Landing page","content":"<h1>Hello</h1>' }),
    ]);

    const [a] = artifactCallsIn([early]);
    const [b] = artifactCallsIn([later]);
    expect(liveArtifactOf(a!.call).content).toBe("<h1>Hel");
    expect(liveArtifactOf(b!.call).content).toBe("<h1>Hello</h1>");
    expect(liveArtifactOf(b!.call)).toMatchObject({ kind: "html", title: "Landing page" });
  });

  it("writes the source with no preview frame while the call streams", () => {
    const [item] = artifactCallsIn([
      streaming("m-1", [
        callPart({ arguments: '{"kind":"html","title":"Landing page","content":"<h1>Hel' }),
      ]),
    ]);
    const live = liveArtifactOf(item!.call);

    const markup = renderToStaticMarkup(
      createElement(LiveArtifactView, {
        title: live.title,
        kind: live.kind,
        language: live.language,
        source: live.content ?? "",
        notice: live.notice,
        onClose: () => {},
      }),
    );

    expect(markup).toContain("&lt;h1&gt;Hel");
    expect(markup).toContain("Landing page");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain('role="tab"');
  });

  it("keeps the previous version under an Updating to vN banner for an edits update", () => {
    const [item] = artifactCallsIn([
      streaming("m-1", [
        callPart({
          id: "call-2",
          name: "update_artifact",
          arguments: '{"artifactId":"a-1","edits":[{"old":"Hi","new":"Hello"}]}',
          state: "input-complete",
        }),
      ]),
    ]);
    const live = liveArtifactOf(item!.call);

    expect(live.content).toBeUndefined();
    expect(live.notice).toBeUndefined();
    expect(live.state).toBe("updating");
    expect(live.edits).toBe(true);
    const markup = renderToStaticMarkup(
      createElement(LiveArtifactView, {
        title: live.title,
        kind: "html",
        language: null,
        source: "<h1>Hi</h1>",
        notice: "Updating to v2…",
        onClose: () => {},
      }),
    );
    expect(markup).toContain("Updating to v2…");
    expect(markup).toContain("&lt;h1&gt;Hi&lt;/h1&gt;");
  });

  it("shows a cut-off call's partial source as not saved", () => {
    const [item] = artifactCallsIn([
      streaming("m-1", [
        callPart({
          arguments: '{"kind":"html","title":"Landing page","content":"<h1>Hel',
          state: "input-complete",
          metadata: { source: "builtin", status: "cancelled" },
        }),
      ]),
    ]);
    const live = liveArtifactOf(item!.call);

    expect(live.state).toBe("not-saved");
    expect(live.content).toBe("<h1>Hel");
    expect(live.notice).toBe("This Artifact wasn't saved");
  });
});
