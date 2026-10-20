// PROTOTYPE (#623): three variants of how a user sees and edits a Bot's memory, on
// /bots/$botId?variant=A|B|C. Stub data in memory (./mock); nothing is wired to the server.
// Lives on branch prototype/623-memory-ui only.
import { useState } from "react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

import { MemoryProvider, useMemory } from "./mock";
import { VariantA, name as nameA } from "./variant-a";
import { VariantB, name as nameB } from "./variant-b";
import { VariantC, name as nameC } from "./variant-c";

const variants = [
  { key: "A", name: nameA },
  { key: "B", name: nameB },
  { key: "C", name: nameC },
];

export function MemoryPrototype({ variant }: { variant: string }) {
  return (
    <MemoryProvider>
      {variant === "B" ? <VariantB /> : variant === "C" ? <VariantC /> : <VariantA />}
      <PrototypeSwitcher variants={variants} current={variant} extra={<Controls />} />
    </MemoryProvider>
  );
}

/** Simulates a Turn and its post-turn pass, and surfaces the full stub state. */
function Controls() {
  const s = useMemory();
  const [open, setOpen] = useState(false);
  const btn = "rounded bg-white/15 px-2 text-xs";
  return (
    <>
      <button type="button" className={`ml-2 ${btn}`} onClick={s.turn}>
        turn + pass
      </button>
      <button type="button" className={btn} onClick={() => setOpen(!open)}>
        state
      </button>
      <button type="button" className={btn} onClick={s.reset}>
        reset
      </button>
      {open && (
        <pre className="absolute bottom-10 left-1/2 max-h-96 w-[32rem] -translate-x-1/2 overflow-auto rounded-lg bg-black p-3 text-[11px] text-white shadow-lg">
          {JSON.stringify({ log: s.log, lines: s.lines }, null, 2)}
        </pre>
      )}
    </>
  );
}
