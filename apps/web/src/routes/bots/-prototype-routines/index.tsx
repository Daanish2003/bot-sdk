// PROTOTYPE (#542): three variants of Routines and Check-ins on /bots/$botId?variant=A|B|C.
// Stub data in memory (./mock); nothing is wired to the server. Lives on branch prototype/542-routines-ui only.
import { useState } from "react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

import { ScheduleProvider, useSchedule } from "./mock";
import { VariantA, name as nameA } from "./variant-a";
import { VariantB, name as nameB } from "./variant-b";
import { VariantC, name as nameC } from "./variant-c";

const variants = [
  { key: "A", name: nameA },
  { key: "B", name: nameB },
  { key: "C", name: nameC },
];

export function RoutinesPrototype({ variant }: { variant: string }) {
  return (
    <ScheduleProvider>
      {variant === "B" ? (
        <VariantB botName="Sales Outbound" />
      ) : variant === "C" ? (
        <VariantC botName="Sales Outbound" />
      ) : (
        <VariantA botName="Sales Outbound" />
      )}
      <PrototypeSwitcher variants={variants} current={variant} extra={<StateToggle />} />
    </ScheduleProvider>
  );
}

/** Surfaces the full stub state and the last actions, so each click shows what changed. */
function StateToggle() {
  const s = useSchedule();
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
      <button type="button" className="rounded bg-white/15 px-2 text-xs" onClick={s.reset}>
        reset
      </button>
      {open && (
        <pre className="absolute bottom-10 left-1/2 max-h-96 w-[32rem] -translate-x-1/2 overflow-auto rounded-lg bg-black p-3 text-[11px] text-white shadow-lg">
          {JSON.stringify(
            {
              log: s.log,
              routines: s.routines.map(({ prompt: _prompt, ...r }) => r),
              checkIns: s.checkIns,
            },
            null,
            2,
          )}
        </pre>
      )}
    </>
  );
}
