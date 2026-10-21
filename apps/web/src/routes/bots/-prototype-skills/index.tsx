// PROTOTYPE (#711): three variants of how a Demonstration and a Bot's Skills look, on
// /bots/$botId?variant=A|B|C. Stub data in memory (./stub); nothing is wired to the server.
// The switcher's buttons start a Demonstration, add a captured browser event, and reset; the
// variant's own buttons do Pause, Done (drafts and saves after 2.5 s), Cancel, and Skill edits.
// Lives on branch prototype/711-skills-ui only.
import { useState } from "react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

import { type Stub, useSkillsStub } from "./stub";
import { VariantA, name as nameA } from "./variant-a";
import { VariantB, name as nameB } from "./variant-b";
import { VariantC, name as nameC } from "./variant-c";

const variants = [
  { key: "A", name: nameA },
  { key: "B", name: nameB },
  { key: "C", name: nameC },
];

export function SkillsPrototype({ variant }: { variant: string }) {
  const stub = useSkillsStub();
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
      <button type="button" className={button} onClick={stub.start}>
        watch_user
      </button>
      <button type="button" className={button} onClick={stub.act}>
        user acts
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
            { demo: stub.demo, skills: stub.skills.map((s) => s.name), items: stub.items },
            null,
            2,
          )}
        </pre>
      )}
    </>
  );
}
