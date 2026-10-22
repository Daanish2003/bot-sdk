// PROTOTYPE (#760) variant C, "Channel strip + timeline": a strip under the header shows both
// Channels, the address inline (copy / rotate) and where replies will go next. The thread is a
// timeline: a divider appears whenever the Channel changes, instead of a per-message marker.
// Reactions are plain footer text lines; rich controls are full-width cards.
import { Fragment } from "react";

import { CopyButton, Frame, RichBody, RotateButton } from "./frame";
import type { Msg, Stub, Via } from "./stub";

export const name = "Channel strip + timeline";

const channelOf = (m: Msg): Via =>
  m.from === "user" ? (m.via ?? "web") : m.emailed ? "email" : "web";

export function VariantC({ stub }: { stub: Stub }) {
  let prev: Via = "web";
  return (
    <Frame>
      <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-1 flex flex-wrap items-center gap-3 border-b bg-muted/60 px-4 py-2 text-xs backdrop-blur">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-emerald-500" /> Web
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-sky-500" /> Email
        </span>
        <code className="rounded bg-background px-2 py-0.5">{stub.address}</code>
        <CopyButton stub={stub} />
        <RotateButton stub={stub} />
        <span className="ml-auto text-muted-foreground">
          Next Bot-initiated Message goes by <b>{stub.lastWrote}</b>
        </span>
      </div>
      {stub.messages.map((m) => {
        const ch = channelOf(m);
        const divider = ch !== prev;
        prev = ch;
        const mine = m.from === "user";
        return (
          <Fragment key={m.id}>
            {divider && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                {ch === "email" ? "✉ by email" : "🌐 on the web"}
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <div
              className={`flex flex-col gap-1.5 border-l-2 pl-3 ${ch === "email" ? "border-sky-400" : "border-emerald-400"}`}
            >
              <div className="text-xs text-muted-foreground">{mine ? "You" : "Planner"}</div>
              <div className="text-sm">{m.text}</div>
              {m.rich && (
                <div className="max-w-md rounded-lg border bg-card p-3">
                  {m.rich.type === "choice" && (
                    <div className="mb-1.5 text-sm font-medium">{m.rich.question}</div>
                  )}
                  <RichBody msg={m} stub={stub} />
                </div>
              )}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {mine && m.botReaction && <span>Planner reacted {m.botReaction}</span>}
                {!mine && (
                  <button
                    type="button"
                    className="hover:text-foreground"
                    onClick={() => stub.reactUser(m.id)}
                  >
                    {m.userReaction ? `You reacted ${m.userReaction}` : "React ♡"}
                  </button>
                )}
              </div>
            </div>
          </Fragment>
        );
      })}
    </Frame>
  );
}
