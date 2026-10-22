// PROTOTYPE (#760) variant B, "Compact + Channels sheet": rich controls live inside the bubble,
// reactions are a hover bar (the reaction itself overlaps the bubble corner), email is a tiny
// envelope glyph in the bubble footer. The address sits in a "Channels" side sheet that lists
// Web and Email with last-used.
import { Button } from "@ai-chat/ui/components/button";
import { useState } from "react";

import { CopyButton, Frame, RichBody, RotateButton } from "./frame";
import type { Msg, Stub } from "./stub";

export const name = "Compact + Channels sheet";

function Bubble({ msg, stub }: { msg: Msg; stub: Stub }) {
  const mine = msg.from === "user";
  const reaction = mine ? msg.botReaction : msg.userReaction;
  return (
    <div className={`group relative flex max-w-[78%] ${mine ? "self-end" : "self-start"}`}>
      <div
        className={`flex flex-col gap-2 rounded-2xl px-3 py-2 text-sm ${mine ? "bg-primary text-primary-foreground" : "bg-muted"}`}
      >
        <div>{msg.text}</div>
        {msg.rich && (
          <div className="rounded-lg bg-background p-2 text-foreground">
            {msg.rich.type === "choice" && (
              <div className="mb-1 text-xs font-medium">{msg.rich.question}</div>
            )}
            <RichBody msg={msg} stub={stub} compact />
          </div>
        )}
        {(msg.via === "email" || msg.emailed) && (
          <span
            className="self-end text-[10px] opacity-70"
            title={msg.via ? "Arrived by email" : "Also sent by email"}
          >
            ✉
          </span>
        )}
      </div>
      {reaction && (
        <span className="absolute -bottom-2 right-2 rounded-full border bg-background px-1 text-xs shadow-sm">
          {reaction}
        </span>
      )}
      {!mine && (
        <div className="invisible absolute -top-3 right-2 flex gap-0.5 rounded-full border bg-background px-1 shadow-sm group-hover:visible">
          {["❤️", "👍", "😂"].map((e) => (
            <button
              key={e}
              type="button"
              className="px-0.5 text-xs"
              onClick={() => stub.reactUser(msg.id, e)}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function VariantB({ stub }: { stub: Stub }) {
  const [open, setOpen] = useState(false);
  return (
    <Frame
      header={
        <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
          Channels 2
        </Button>
      }
      overlay={
        open && (
          <div
            className="absolute inset-0 z-40 flex justify-end bg-black/30"
            onClick={() => setOpen(false)}
          >
            <aside
              className="flex h-full w-96 flex-col gap-4 border-l bg-background p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center">
                <h2 className="font-semibold">Channels</h2>
                <Button
                  className="ml-auto"
                  size="xs"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                >
                  Close
                </Button>
              </div>
              <section className="rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  🌐 Web{" "}
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    always on
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {stub.lastWrote === "web" ? "Last used: just now" : "Last used: earlier"}
                </div>
              </section>
              <section className="rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  ✉ Email
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    {stub.lastWrote === "email" ? "Last used: just now" : "Not used yet"}
                  </span>
                </div>
                <code className="mt-2 block break-all rounded bg-muted px-2 py-1 text-xs">
                  {stub.address}
                </code>
                <div className="mt-2 flex items-center gap-2">
                  <CopyButton stub={stub} />
                  <RotateButton stub={stub} />
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Rotating makes the old address stop working. Bot-initiated Messages go to{" "}
                  <b>{stub.lastWrote}</b> (where you last wrote).
                </p>
              </section>
            </aside>
          </div>
        )
      }
    >
      {stub.messages.map((m) => (
        <Bubble key={m.id} msg={m} stub={stub} />
      ))}
    </Frame>
  );
}
