// PROTOTYPE (#574): three variants of Helpers, the to-do list and the Computer card on
// /bots/$botId?variant=A|B|C. Stub data in memory (./mock); nothing is wired to the server.
// Lives on branch prototype/574-helpers-ui only.
import { useState } from "react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

import { HelpersProvider, useHelpers } from "./mock";
import { VariantA, name as nameA } from "./variant-a";
import { VariantB, name as nameB } from "./variant-b";
import { VariantC, name as nameC } from "./variant-c";

const variants = [
  { key: "A", name: nameA },
  { key: "B", name: nameB },
  { key: "C", name: nameC },
];

export function HelpersPrototype({ variant }: { variant: string }) {
  return (
    <HelpersProvider>
      {variant === "B" ? (
        <VariantB botName="Sales Outbound" />
      ) : variant === "C" ? (
        <VariantC botName="Sales Outbound" />
      ) : (
        <VariantA botName="Sales Outbound" />
      )}
      <PrototypeSwitcher variants={variants} current={variant} extra={<Controls />} />
    </HelpersProvider>
  );
}

/** Simulates what the server would do, and surfaces the full stub state. */
function Controls() {
  const s = useHelpers();
  const [open, setOpen] = useState(false);
  const btn = "rounded bg-white/15 px-2 text-xs";
  return (
    <>
      <button type="button" className={`ml-2 ${btn}`} onClick={s.advance}>
        step
      </button>
      <button type="button" className={btn} onClick={() => s.start("general")}>
        +general
      </button>
      <button type="button" className={btn} onClick={() => s.start("computer_use")}>
        +computer
      </button>
      <button type="button" className={btn} onClick={s.askUser}>
        ask_user
      </button>
      <button type="button" className={btn} onClick={() => setOpen(!open)}>
        state
      </button>
      <button type="button" className={btn} onClick={s.reset}>
        reset
      </button>
      {open && (
        <pre className="absolute bottom-10 left-1/2 max-h-96 w-[32rem] -translate-x-1/2 overflow-auto rounded-lg bg-black p-3 text-[11px] text-white shadow-lg">
          {JSON.stringify(
            {
              log: s.log,
              helpers: s.helpers.map(({ task: _task, ...h }) => h),
            },
            null,
            2,
          )}
        </pre>
      )}
    </>
  );
}
