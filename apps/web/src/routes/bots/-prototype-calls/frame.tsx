// PROTOTYPE (#1366): the bare Bot page and pieces the Call variants share. Never merge to main.
import { Button } from "@ai-chat/ui/components/button";
import { Input } from "@ai-chat/ui/components/input";
import type { ReactNode } from "react";

import { type Msg, type Stub, telnyxChecklist, webhookUrl } from "./stub";

export function Frame({
  header,
  children,
  overlay,
  top,
}: {
  header?: ReactNode;
  children?: ReactNode;
  overlay?: ReactNode;
  top?: ReactNode;
}) {
  return (
    <div className="relative flex h-dvh flex-col bg-background">
      <header className="relative flex items-center gap-2 border-b px-4 py-2">
        <span className="font-semibold">Planner</span>
        <span className="text-xs text-muted-foreground">Bot · claude-sonnet-5-5</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="xs">
            Memory
          </Button>
          <Button variant="outline" size="xs">
            Email
          </Button>
          {header}
          <Button variant="outline" size="xs">
            Tasks 1
          </Button>
        </div>
      </header>
      {top}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-3 overflow-auto p-4 pb-24">
          {children}
        </div>
        <div className="border-t p-3">
          <div className="mx-auto max-w-3xl rounded-xl border px-3 py-2 text-sm text-muted-foreground">
            Message Planner…
          </div>
        </div>
      </main>
      {overlay}
    </div>
  );
}

export function channelTag(channel: string) {
  if (channel === "phone") return "📞 by phone";
  if (channel === "sms") return "SMS";
  return null;
}

/** A user or Bot Message bubble; the variants decide what goes around it. */
export function Bubble({ msg, stub, extra }: { msg: Msg; stub: Stub; extra?: ReactNode }) {
  if (msg.kind !== "user" && msg.kind !== "bot") return null;
  const mine = msg.kind === "user";
  const tag = channelTag(msg.channel);
  return (
    <div className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${mine ? "bg-primary text-primary-foreground" : "bg-muted"}`}
      >
        {msg.text}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{msg.at}</span>
        {tag && <span>{tag}</span>}
        {extra}
      </div>
      {msg.kind === "bot" && msg.approval && <ApprovalCard msg={msg} stub={stub} />}
    </div>
  );
}

export function ApprovalCard({ msg, stub, note }: { msg: Msg; stub: Stub; note?: ReactNode }) {
  if (msg.kind !== "bot" || !msg.approval) return null;
  const { action, answer } = msg.approval;
  return (
    <div className="flex w-full max-w-md flex-col gap-2 rounded-lg border bg-background p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">Approval</span>
        {note}
        <span className="ml-auto text-xs text-muted-foreground">waits · stays pending</span>
      </div>
      <code className="text-xs">{action}</code>
      {answer ? (
        <span className="text-xs text-emerald-700">{answer}</span>
      ) : (
        <div className="flex gap-2">
          <Button size="xs" onClick={() => stub.answer(msg.id, "approved")}>
            Approve
          </Button>
          <Button size="xs" variant="outline" onClick={() => stub.answer(msg.id, "denied")}>
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}

export function CallsFields() {
  return (
    <div className="flex flex-col gap-1.5">
      <Input placeholder="OpenAI project ID (proj_…)" />
      <Input type="password" placeholder="OpenAI API key" />
      <Input type="password" placeholder="Webhook signing secret" />
    </div>
  );
}

export function WebhookRow() {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1">
      <code className="min-w-0 flex-1 truncate text-[11px]">{webhookUrl}</code>
      <Button size="xs" variant="outline">
        Copy
      </Button>
    </div>
  );
}

export function Checklist({ boxes }: { boxes?: boolean }) {
  return (
    <ol className="flex list-inside list-decimal flex-col gap-1 text-xs text-muted-foreground">
      {telnyxChecklist.map((step) => (
        <li key={step}>
          {boxes && <input type="checkbox" className="mr-1 align-middle" />}
          {step}
        </li>
      ))}
    </ol>
  );
}
