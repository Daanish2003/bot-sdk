// PROTOTYPE (#1366) B, "Flat with markers": phone Messages sit in the normal flow between
// start/end dividers, a sticky banner while live; "Phone calls" is its own Channels row with a setup dialog.
import { Button } from "@ai-chat/ui/components/button";
import { useState } from "react";

import { Bubble, CallsFields, Checklist, Frame, WebhookRow } from "./frame";
import type { Stub } from "./stub";

export function VariantB({ stub }: { stub: Stub }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  return (
    <Frame
      header={
        <Button variant="outline" size="xs" onClick={() => setOpen(!open)}>
          Channels
        </Button>
      }
      top={
        stub.live && (
          <div className="flex items-center gap-2 border-b bg-emerald-50 px-4 py-1.5 text-sm text-emerald-900">
            <span className="size-2 animate-pulse rounded-full bg-emerald-600" />
            You're on a call with Planner · {stub.clock}
            <span className="text-xs text-emerald-800/70">
              its replies are spoken, and kept here
            </span>
            <span className="ml-auto text-xs">ends at 10:00</span>
          </div>
        )
      }
      overlay={
        <>
          {open && (
            <div className="absolute top-12 right-24 z-40 flex w-80 flex-col gap-3 rounded-xl border bg-popover p-3 text-sm shadow-lg">
              <Row name="Telegram" handle="@planner_bot" />
              <Row name="SMS" handle="+1 415 555 0134" />
              <div className="flex items-center gap-2">
                <span className="font-medium">Phone calls</span>
                <span className="text-xs text-muted-foreground">on +1 415 555 0134</span>
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => setDialog(true)}
                >
                  Set up
                </Button>
              </div>
            </div>
          )}
          {dialog && <SetupDialog onClose={() => setDialog(false)} />}
        </>
      }
    >
      {stub.messages.map((m) => {
        if (m.kind === "call-start")
          return <Divider key={m.id} text={`📞 Call started · ${m.at}`} />;
        if (m.kind === "call-end")
          return <Divider key={m.id} text={`Call ended · ${m.minutes} min · ${m.reason}`} />;
        return (
          <Bubble
            key={m.id}
            msg={m}
            stub={stub}
            extra={
              m.kind === "bot" && m.channel === "phone" ? (
                <span>{m.spoken ? "🔊 spoken" : "🔇 not spoken"}</span>
              ) : null
            }
          />
        );
      })}
    </Frame>
  );
}

function Divider({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {text}
      <span className="h-px flex-1 bg-border" />
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

function SetupDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const steps = ["Telnyx", "OpenAI", "Test call"];
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="flex w-[30rem] flex-col gap-4 rounded-xl border bg-background p-4 text-sm shadow-xl">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Phone calls on +1 415 555 0134</span>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={onClose}>
            ✕
          </Button>
        </div>
        <ol className="flex gap-2 text-xs">
          {steps.map((s, i) => (
            <li
              key={s}
              className={`rounded-full px-2 py-0.5 ${i === step ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            >
              {i + 1}. {s}
            </li>
          ))}
        </ol>
        {step === 0 && (
          <>
            <p className="text-xs">
              Point the number at OpenAI. Copy this URL first; step 5 needs it.
            </p>
            <WebhookRow />
            <Checklist />
          </>
        )}
        {step === 1 && (
          <>
            <p className="text-xs">From the same OpenAI project the number points at.</p>
            <CallsFields />
          </>
        )}
        {step === 2 && (
          <div className="flex flex-col gap-2 text-xs">
            <p>Call +1 415 555 0134 from your linked number (+44 7700 900123).</p>
            <p className="rounded-md bg-muted p-2">
              ⏳ Waiting for a call… the first one confirms the webhook and signature.
            </p>
          </div>
        )}
        <div className="flex gap-2">
          {step > 0 && (
            <Button size="xs" variant="outline" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <Button
            size="xs"
            className="ml-auto"
            onClick={() => (step < 2 ? setStep(step + 1) : onClose())}
          >
            {step < 2 ? "Next" : "Done"}
          </Button>
        </div>
      </div>
    </div>
  );
}
