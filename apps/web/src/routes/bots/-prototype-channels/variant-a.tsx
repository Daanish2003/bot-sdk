// PROTOTYPE (#760) variant A, "Inline + popover": everything sits in the thread under its bubble
// (rich controls, a "via email" / "emailed" pill, a reaction row). The address lives in an
// "Email" popover in the Bot's header.
import { Button } from "@ai-chat/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ai-chat/ui/components/popover";

import { CopyButton, Frame, RichBody, RotateButton } from "./frame";
import type { Msg, Stub } from "./stub";

export const name = "Inline + popover";

function Pill({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-900">{children}</span>
  );
}

function Bubble({ msg, stub }: { msg: Msg; stub: Stub }) {
  const mine = msg.from === "user";
  return (
    <div
      className={`flex max-w-[80%] flex-col gap-1.5 ${mine ? "self-end items-end" : "self-start"}`}
    >
      <div
        className={`rounded-2xl px-3 py-2 text-sm ${mine ? "bg-primary text-primary-foreground" : "bg-muted"}`}
      >
        {msg.text}
      </div>
      {msg.rich && (
        <div className="w-full min-w-64 rounded-xl border bg-card p-2">
          {msg.rich.type === "choice" && (
            <div className="mb-1.5 text-xs font-medium">{msg.rich.question}</div>
          )}
          <RichBody msg={msg} stub={stub} />
        </div>
      )}
      <div className="flex items-center gap-2">
        {msg.via === "email" && <Pill>via email</Pill>}
        {msg.emailed && <Pill>✉ emailed</Pill>}
        {mine && msg.botReaction && (
          <span className="rounded-full border px-1.5 text-xs" title="Planner reacted">
            {msg.botReaction}
          </span>
        )}
        {!mine && (
          <button
            type="button"
            onClick={() => stub.reactUser(msg.id)}
            className={`rounded-full border px-1.5 text-xs ${msg.userReaction ? "bg-rose-50" : "opacity-50 hover:opacity-100"}`}
          >
            {msg.userReaction ?? "♡"}
          </button>
        )}
      </div>
    </div>
  );
}

export function VariantA({ stub }: { stub: Stub }) {
  return (
    <Frame
      header={
        <Popover>
          <PopoverTrigger
            render={
              <Button variant="outline" size="xs">
                ✉ Email
              </Button>
            }
          />
          <PopoverContent align="end" className="w-96">
            <div className="text-xs text-muted-foreground">
              Email this Bot at its private address. Replies come back by email when you wrote by
              email; the web always shows everything.
            </div>
            <code className="break-all rounded bg-muted px-2 py-1 text-xs">{stub.address}</code>
            <div className="flex items-center gap-2">
              <CopyButton stub={stub} label="Copy address" />
              <RotateButton stub={stub} />
              {stub.rotations > 0 && (
                <span className="text-[11px] text-amber-700">rotated ×{stub.rotations}</span>
              )}
            </div>
          </PopoverContent>
        </Popover>
      }
    >
      {stub.messages.map((m) => (
        <Bubble key={m.id} msg={m} stub={stub} />
      ))}
    </Frame>
  );
}
