// PROTOTYPE (#1366) A, "Call block": a Call's Messages grouped in one block in the thread;
// Calls is a toggle under the SMS row of the Channels popover.
import { Button } from "@ai-chat/ui/components/button";
import { useState } from "react";

import { Bubble, CallsFields, Checklist, Frame, WebhookRow } from "./frame";
import type { Msg, Stub } from "./stub";

export function VariantA({ stub }: { stub: Stub }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const outside = stub.messages.filter((m) => !inCall(m));
  const call = stub.messages.filter(inCall);
  const end = stub.messages.find((m) => m.kind === "call-end");
  const firstAfter = outside.findIndex((m) => m.id === "e3");
  const beforeCall = firstAfter === -1 ? outside : outside.slice(0, firstAfter);
  const afterCall = firstAfter === -1 ? [] : outside.slice(firstAfter);
  return (
    <Frame
      header={
        <>
          {stub.live && (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900">
              <span className="size-2 animate-pulse rounded-full bg-emerald-600" /> On a call{" "}
              {stub.clock}
            </span>
          )}
          <Button variant="outline" size="xs" onClick={() => setOpen(!open)}>
            Channels
          </Button>
        </>
      }
      overlay={open && <Popover />}
    >
      {beforeCall.map((m) => (
        <Bubble key={m.id} msg={m} stub={stub} />
      ))}
      <section
        className={`flex flex-col gap-3 rounded-xl border p-3 ${stub.live ? "border-emerald-400" : ""}`}
      >
        <button
          type="button"
          className="flex items-center gap-2 text-left text-sm"
          onClick={() => setExpanded(!expanded)}
        >
          <span>📞</span>
          <span className="font-medium">Call</span>
          <span className="text-xs text-muted-foreground">
            {stub.live
              ? `live · ${stub.clock} · replies are spoken`
              : `14:02 · ${end?.kind === "call-end" ? end.minutes : 0} min · ${end?.kind === "call-end" ? end.reason : ""}`}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {expanded ? "Hide" : `Show ${call.length}`}
          </span>
        </button>
        {expanded &&
          call
            .filter((m) => m.kind === "user" || m.kind === "bot")
            .map((m) => (
              <Bubble
                key={m.id}
                msg={m}
                stub={stub}
                extra={
                  m.kind === "bot" && m.spoken === false ? (
                    <span className="italic">not spoken (you'd moved on)</span>
                  ) : m.kind === "user" && m.noTurn ? (
                    <span className="italic">after the last reply</span>
                  ) : null
                }
              />
            ))}
      </section>
      {afterCall.map((m) => (
        <Bubble key={m.id} msg={m} stub={stub} />
      ))}
    </Frame>
  );
}

function inCall(m: Msg) {
  return (
    m.kind === "call-start" || m.kind === "call-end" || ("channel" in m && m.channel === "phone")
  );
}

function Popover() {
  const [calls, setCalls] = useState(false);
  return (
    <div className="absolute top-12 right-24 z-40 flex w-96 flex-col gap-3 rounded-xl border bg-popover p-3 text-sm shadow-lg">
      <Row name="Telegram" handle="@planner_bot" />
      <div className="flex flex-col gap-2">
        <Row name="SMS" handle="+1 415 555 0134" />
        <label className="ml-3 flex items-center gap-2 border-l pl-3">
          <input type="checkbox" checked={calls} onChange={(e) => setCalls(e.target.checked)} />
          <span>Take calls on this number</span>
          {!calls && <span className="ml-auto text-xs text-muted-foreground">off</span>}
        </label>
        {calls && (
          <div className="ml-3 flex flex-col gap-2 border-l pl-3">
            <p className="text-xs text-muted-foreground">
              Calls go from Telnyx to OpenAI's voice model, which hands every request to this Bot.
              Only your linked number gets through.
            </p>
            <CallsFields />
            <WebhookRow />
            <details>
              <summary className="cursor-pointer text-xs">
                Telnyx and OpenAI setup (5 steps)
              </summary>
              <Checklist />
            </details>
            <Button size="xs" className="self-start">
              Save
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ name, handle }: { name: string; handle: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-medium">{name}</span>
      <span className="text-xs text-muted-foreground">{handle}</span>
      <Button size="xs" variant="ghost" className="ml-auto">
        Remove
      </Button>
    </div>
  );
}
