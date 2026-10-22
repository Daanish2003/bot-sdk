// PROTOTYPE (#760): the bare Bot page and small pieces the variants share.
import { Button } from "@ai-chat/ui/components/button";
import { type ReactNode, useState } from "react";

import { type Msg, type Rich, type Stub, kb } from "./stub";

export function Frame({
  header,
  children,
  overlay,
}: {
  header?: ReactNode;
  children?: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div className="relative flex h-dvh flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <span className="font-semibold">Planner</span>
        <span className="text-xs text-muted-foreground">Bot · claude-sonnet-5-5</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="xs">
            Memory
          </Button>
          <Button variant="outline" size="xs">
            Skills 4
          </Button>
          {header}
        </div>
      </header>
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

export function CopyButton({ stub, label = "Copy" }: { stub: Stub; label?: string }) {
  return (
    <Button size="xs" variant="outline" onClick={stub.copy}>
      {stub.copied ? "Copied" : label}
    </Button>
  );
}

export function RotateButton({ stub }: { stub: Stub }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => {
        if (window.confirm("Rotate? The old address stops working immediately.")) stub.rotate();
      }}
    >
      Rotate
    </Button>
  );
}

/** Multiple choice: single answer, optional "Other"; first answer wins, then "answered". */
export function Choice({ msg, stub, compact }: { msg: Msg; stub: Stub; compact?: boolean }) {
  const [other, setOther] = useState("");
  const rich = msg.rich as Extract<Rich, { type: "choice" }>;
  if (rich.answer)
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-900">answered</span>
        {rich.answer}
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5">
      <div className={`flex gap-1.5 ${compact ? "flex-wrap" : "flex-col items-stretch"}`}>
        {rich.options.map((o) => (
          <Button
            key={o}
            size="sm"
            variant="outline"
            className="justify-start"
            onClick={() => stub.answer(msg.id, o)}
          >
            {o}
          </Button>
        ))}
      </div>
      {rich.allowOther && (
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (other.trim()) stub.answer(msg.id, `Other: ${other.trim()}`);
          }}
        >
          <input
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="Other…"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
          />
          <Button size="sm" type="submit" disabled={!other.trim()}>
            Send
          </Button>
        </form>
      )}
    </div>
  );
}

export function Files({
  rich,
  inline,
}: {
  rich: Extract<Rich, { type: "files" }>;
  inline?: boolean;
}) {
  return (
    <ul className={`flex gap-1.5 ${inline ? "flex-wrap" : "flex-col"}`}>
      {rich.files.map((f) => (
        <li key={f.name}>
          <a
            href="#"
            onClick={(e) => e.preventDefault()}
            className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-sm hover:bg-muted"
          >
            <span>{f.name.endsWith(".pdf") ? "📕" : "📊"}</span>
            <span className="truncate">{f.name}</span>
            <span className="text-xs text-muted-foreground">{kb(f.kb)}</span>
            <span className="ml-1 text-xs">⬇</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** An existing card kind (Secret entry), shown only for thread density. */
export function SecretCard({ msg, stub }: { msg: Msg; stub: Stub }) {
  const rich = msg.rich as Extract<Rich, { type: "secret" }>;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed bg-background px-2.5 py-2 text-sm">
      <span>🔑</span>
      <span className="font-mono text-xs">{rich.label}</span>
      {rich.done ? (
        <span className="ml-auto text-xs text-emerald-700">saved</span>
      ) : (
        <Button size="xs" className="ml-auto" onClick={() => stub.resolveSecret(msg.id)}>
          Enter value
        </Button>
      )}
    </div>
  );
}

export function RichBody({ msg, stub, compact }: { msg: Msg; stub: Stub; compact?: boolean }) {
  const rich = msg.rich;
  if (!rich) return null;
  if (rich.type === "choice") return <Choice msg={msg} stub={stub} compact={compact} />;
  if (rich.type === "files") return <Files rich={rich} inline={compact} />;
  return <SecretCard msg={msg} stub={stub} />;
}
