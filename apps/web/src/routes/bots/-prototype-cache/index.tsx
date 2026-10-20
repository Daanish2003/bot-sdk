// PROTOTYPE (#663): three variants of how apps/web shows prompt-cache hits per section for each
// Turn, on /bots/$botId?variant=A|B|C. Stub data in memory (./mock); nothing is wired to the server.
// Lives on branch prototype/663-cache-ui only.
import { useState } from "react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

import { allSteps } from "./mock";
import { VariantA, name as nameA } from "./variant-a";
import { VariantB, name as nameB } from "./variant-b";
import { VariantC, name as nameC } from "./variant-c";

const variants = [
  { key: "A", name: nameA },
  { key: "B", name: nameB },
  { key: "C", name: nameC },
];

export function CachePrototype({ variant }: { variant: string }) {
  return (
    <>
      {variant === "B" ? <VariantB /> : variant === "C" ? <VariantC /> : <VariantA />}
      <PrototypeSwitcher variants={variants} current={variant} extra={<State />} />
    </>
  );
}

/** Surfaces the full stub state: every model call with its section hashes and tokens. */
function State() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ml-2 rounded bg-white/15 px-2 text-xs"
        onClick={() => setOpen(!open)}
      >
        state
      </button>
      {open && (
        <pre className="absolute bottom-10 left-1/2 max-h-96 w-[36rem] -translate-x-1/2 overflow-auto rounded-lg bg-black p-3 text-[11px] text-white shadow-lg">
          {JSON.stringify(
            allSteps.map(({ item, step }) => ({ kind: item.kind, ...step })),
            null,
            2,
          )}
        </pre>
      )}
    </>
  );
}
