// PROTOTYPE (#734): three variants of how Knowledge looks, on /bots/$botId?variant=A|B|C.
// Stub data in memory (./stub); nothing is wired to the server or the Computer.
// The switcher's buttons simulate an upload going through its states, a scan refusal, a
// Knowledge-full refusal, an over-20 MB refusal, a "Replace?" prompt, a Bot saving a file, and reset.
// Lives on branch prototype/734-knowledge-ui only.
import { useState } from "react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

import { type Stub, totalKb, useKnowledgeStub } from "./stub";
import { VariantA, name as nameA } from "./variant-a";
import { VariantB, name as nameB } from "./variant-b";
import { VariantC, name as nameC } from "./variant-c";

const variants = [
  { key: "A", name: nameA },
  { key: "B", name: nameB },
  { key: "C", name: nameC },
];

export function KnowledgePrototype({ variant }: { variant: string }) {
  const stub = useKnowledgeStub();
  return (
    <>
      {variant === "B" ? (
        <VariantB stub={stub} />
      ) : variant === "C" ? (
        <VariantC stub={stub} />
      ) : (
        <VariantA stub={stub} />
      )}
      <PrototypeSwitcher
        variants={variants}
        current={variant}
        extra={<Controls stub={stub} inThread={variant === "C"} />}
      />
    </>
  );
}

function Controls({ stub, inThread }: { stub: Stub; inThread: boolean }) {
  const [open, setOpen] = useState(false);
  const button = "ml-1 rounded bg-white/15 px-2 text-xs";
  return (
    <>
      <button type="button" className={button} onClick={() => stub.upload(inThread)}>
        upload
      </button>
      <button type="button" className={button} onClick={() => stub.scan(inThread)}>
        scan
      </button>
      <button type="button" className={button} onClick={() => stub.full(inThread)}>
        full
      </button>
      <button type="button" className={button} onClick={() => stub.tooBig(inThread)}>
        &gt;20MB
      </button>
      <button type="button" className={button} onClick={stub.replace}>
        replace?
      </button>
      <button type="button" className={button} onClick={stub.botSaves}>
        bot saves
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
            {
              usedKb: totalKb(stub.files),
              ask: stub.ask,
              folders: stub.folders,
              files: stub.files.map((f) => ({
                path: f.path,
                copy: f.copy ? `${f.path}.md` : undefined,
                status: f.status,
                reason: f.reason,
                savedBy: f.savedBy,
              })),
              items: stub.items,
            },
            null,
            2,
          )}
        </pre>
      )}
    </>
  );
}
