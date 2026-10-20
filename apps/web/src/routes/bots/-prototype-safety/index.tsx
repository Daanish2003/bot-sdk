// PROTOTYPE (#689): three variants of how a Bot's Approval requests, Auto-review verdicts and Secrets
// look, on /bots/$botId?variant=A|B|C. Stub data in memory (./stub); nothing is wired to the server.
// The switcher's buttons set off a block from the Bot (a Turn is live), from a Helper (no Turn is
// live), a reviewer failure, a pass, and a Secret request; each request closes itself after 15 s.
// Lives on branch prototype/689-approval-ui only.
import { useState } from "react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

import { type Stub, useSafetyStub } from "./stub";
import { VariantA, name as nameA } from "./variant-a";
import { VariantB, name as nameB } from "./variant-b";
import { VariantC, name as nameC } from "./variant-c";

const variants = [
  { key: "A", name: nameA },
  { key: "B", name: nameB },
  { key: "C", name: nameC },
];

export function SafetyPrototype({ variant }: { variant: string }) {
  const stub = useSafetyStub();
  return (
    <>
      {variant === "B" ? (
        <VariantB stub={stub} />
      ) : variant === "C" ? (
        <VariantC stub={stub} />
      ) : (
        <VariantA stub={stub} />
      )}
      <PrototypeSwitcher variants={variants} current={variant} extra={<Controls stub={stub} />} />
    </>
  );
}

function Controls({ stub }: { stub: Stub }) {
  const [open, setOpen] = useState(false);
  const button = "ml-1 rounded bg-white/15 px-2 text-xs";
  return (
    <>
      <button type="button" className={button} onClick={() => stub.block("bot")}>
        block
      </button>
      <button type="button" className={button} onClick={() => stub.block("helper")}>
        helper block
      </button>
      <button type="button" className={button} onClick={() => stub.block("error")}>
        reviewer fails
      </button>
      <button type="button" className={button} onClick={stub.pass}>
        pass
      </button>
      <button type="button" className={button} onClick={stub.askSecret}>
        ask secret
      </button>
      <button type="button" className={button} onClick={stub.reset}>
        reset
      </button>
      <button type="button" className={button} onClick={() => setOpen(!open)}>
        state
      </button>
      {open && (
        <pre className="absolute bottom-10 left-1/2 max-h-96 w-[40rem] -translate-x-1/2 overflow-auto rounded-lg bg-black p-3 text-[11px] text-white shadow-lg">
          {JSON.stringify(
            { turnLive: stub.turnLive, secrets: stub.secrets, items: stub.items },
            null,
            2,
          )}
        </pre>
      )}
    </>
  );
}
