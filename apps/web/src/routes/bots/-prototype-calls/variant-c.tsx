// PROTOTYPE (#1366) C, "Call record + live dock": one summary card per Call with the transcript
// behind "Show transcript", a floating dock with live captions; settings as a side sheet with health checks.
import { Button } from "@ai-chat/ui/components/button";
import { useState } from "react";

import { ApprovalCard, Bubble, CallsFields, Checklist, Frame, WebhookRow } from "./frame";
import type { Msg, Stub } from "./stub";

export function VariantC({ stub }: { stub: Stub }) {
  const [sheet, setSheet] = useState(false);
  const [transcript, setTranscript] = useState(false);
  const isCall = (m: Msg) =>
    m.kind === "call-start" || m.kind === "call-end" || ("channel" in m && m.channel === "phone");
  const call = stub.messages.filter(isCall);
  const said = call.filter(
    (m): m is Extract<Msg, { kind: "user" | "bot" }> => m.kind === "user" || m.kind === "bot",
  );
  const asks = said.filter((m) => m.kind === "user" && !m.noTurn).length;
  const approvals = said.filter((m) => m.kind === "bot" && m.approval);
  const end = call.find((m) => m.kind === "call-end");
  const others = stub.messages.filter((m) => !isCall(m));
  const split = others.findIndex((m) => m.id === "e3");
  return (
    <Frame
      header={
        <Button variant="outline" size="xs" onClick={() => setSheet(true)}>
          Channels
        </Button>
      }
      overlay={
        <>
          {stub.live && <Dock stub={stub} said={said} />}
          {sheet && <Sheet onClose={() => setSheet(false)} />}
        </>
      }
    >
      {(split === -1 ? others : others.slice(0, split)).map((m) => (
        <Bubble key={m.id} msg={m} stub={stub} />
      ))}
      <div className="flex flex-col gap-2 rounded-xl border bg-muted/30 p-3 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-lg">📞</span>
          <div className="flex flex-col">
            <span className="font-medium">
              {stub.live ? "Call in progress" : "Call from +44 7700 900123"}
            </span>
            <span className="text-xs text-muted-foreground">
              14:02 ·{" "}
              {stub.live
                ? stub.clock
                : `${end?.kind === "call-end" ? end.minutes : 0} min, ${end?.kind === "call-end" ? end.reason : ""}`}{" "}
              · {asks} requests · {approvals.length} approval
            </span>
          </div>
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            onClick={() => setTranscript(!transcript)}
          >
            {transcript ? "Hide transcript" : "Show transcript"}
          </Button>
        </div>
        <ul className="list-inside list-disc text-xs text-muted-foreground">
          <li>Read out tomorrow's calendar</li>
          <li>Asked to move the dentist to Friday: needs your approval</li>
          <li>Friday's weather</li>
        </ul>
        {transcript && (
          <div className="flex flex-col gap-2 border-t pt-2">
            {said.map((m) => (
              <Bubble
                key={m.id}
                msg={{ ...m, ...(m.kind === "bot" ? { approval: undefined } : {}) } as Msg}
                stub={stub}
                extra={
                  m.kind === "bot" && m.spoken === false ? (
                    <span className="italic">not spoken</span>
                  ) : null
                }
              />
            ))}
          </div>
        )}
      </div>
      {approvals.map((m) => (
        <ApprovalCard
          key={m.id}
          msg={m}
          stub={stub}
          note={
            <span className="rounded-full bg-amber-100 px-2 text-xs text-amber-900">
              asked on your call
            </span>
          }
        />
      ))}
      {split !== -1 && others.slice(split).map((m) => <Bubble key={m.id} msg={m} stub={stub} />)}
    </Frame>
  );
}

function Dock({ stub, said }: { stub: Stub; said: Msg[] }) {
  const last = said.slice(-2);
  return (
    <div className="absolute right-4 bottom-20 z-40 flex w-72 flex-col gap-2 rounded-xl border bg-background p-3 text-sm shadow-xl">
      <div className="flex items-center gap-2">
        <span className="size-2 animate-pulse rounded-full bg-emerald-600" />
        <span className="font-medium">On a call · {stub.clock}</span>
        <span className="ml-auto text-xs text-muted-foreground">/ 10:00</span>
      </div>
      {last.map((m) =>
        m.kind === "user" || m.kind === "bot" ? (
          <p key={m.id} className="text-xs">
            <span className="text-muted-foreground">
              {m.kind === "user" ? "You: " : "Planner: "}
            </span>
            {m.text}
          </p>
        ) : null,
      )}
    </div>
  );
}

function Sheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-y-0 right-0 z-50 flex w-[26rem] flex-col gap-4 overflow-auto border-l bg-background p-4 text-sm shadow-xl">
      <div className="flex items-center">
        <span className="font-semibold">Channels</span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onClose}>
          ✕
        </Button>
      </div>
      <section className="flex flex-col gap-1">
        <span className="font-medium">SMS · +1 415 555 0134</span>
        <span className="text-xs text-muted-foreground">Telnyx · working</span>
      </section>
      <section className="flex flex-col gap-2 rounded-lg border p-3">
        <span className="font-medium">Calls on this number</span>
        <ul className="flex flex-col gap-1 text-xs">
          <li>✅ Credentials saved</li>
          <li>✅ Webhook received, signature valid</li>
          <li>⚠️ Last call declined: +1 202 555 0188 isn't your linked number</li>
          <li>Last call: today 14:02, 4 min</li>
        </ul>
        <CallsFields />
        <WebhookRow />
        <p className="text-xs font-medium">Setup checklist</p>
        <Checklist boxes />
        <Button size="xs" className="self-start">
          Save
        </Button>
      </section>
    </div>
  );
}
