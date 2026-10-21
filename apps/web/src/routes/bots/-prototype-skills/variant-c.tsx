// PROTOTYPE (#711) variant C, "Side dock": the chat stays usable while a right-hand dock holds the
// Screen (with the recording controls) and a Skills tab. The thread only carries a slim status line.
import { useEffect, useState } from "react";

import { EventList, FakeScreen, Frame, RecDot, SkillEditor, statusText, Thread } from "./frame";
import type { Stub } from "./stub";

export const name = "Side dock";

type Tab = "screen" | "skills";

export function VariantC({ stub }: { stub: Stub }) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const demo = stub.demo;
  const live = demo && (demo.status === "recording" || demo.status === "paused");

  useEffect(() => {
    if (live) setTab("screen");
  }, [live]);

  const dock = tab && (
    <aside className="flex w-[28rem] shrink-0 flex-col border-l">
      <div className="flex border-b text-sm">
        {(["screen", "skills"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`px-4 py-2 ${tab === t ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
            onClick={() => setTab(t)}
          >
            {t === "screen" ? "Screen" : `Skills ${stub.skills.length}`}
          </button>
        ))}
        <button
          type="button"
          className="ml-auto px-3 text-muted-foreground"
          onClick={() => setTab(null)}
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {tab === "screen" &&
          (demo ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm">
                <RecDot demo={demo} />
                <span className="font-medium">{statusText[demo.status]}</span>
                <span className="font-mono text-xs text-muted-foreground">{stub.elapsed}</span>
              </div>
              <div className="text-xs text-muted-foreground">{demo.goal}</div>
              <FakeScreen demo={demo} />
              {live && (
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1"
                    onClick={stub.pause}
                  >
                    {demo.status === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1"
                    onClick={stub.cancel}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ml-auto rounded-md bg-primary px-3 py-1 text-primary-foreground"
                    onClick={stub.done}
                  >
                    Done
                  </button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Planner sees what you do while recording. Pause before a sign-in.
              </p>
              <EventList demo={demo} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No one is using the Screen.</p>
          ))}
        {tab === "skills" && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="self-end rounded-md border px-2 py-1 text-xs"
              onClick={stub.create}
            >
              New Skill
            </button>
            {stub.skills.map((s) => (
              <div key={s.name} className="rounded-lg border p-2">
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setSelected(selected === s.name ? null : s.name)}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {s.name}
                    {s.problem && (
                      <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-900">
                        not usable
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground">{s.updatedAt}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.description || "(no description)"}
                  </div>
                </button>
                {selected === s.name && (
                  <div className="mt-2">
                    <SkillEditor
                      skill={s}
                      onSave={(body) => stub.update(s.name, body)}
                      onDelete={() => stub.remove(s.name)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <Frame
      header={
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs"
          onClick={() => setTab("skills")}
        >
          Skills {stub.skills.length}
        </button>
      }
      side={dock}
    >
      <Thread
        items={stub.items}
        demo={() =>
          demo && (
            <button
              type="button"
              className="flex items-center gap-2 self-start text-xs text-muted-foreground"
              onClick={() => setTab("screen")}
            >
              <RecDot demo={demo} /> Show me · {statusText[demo.status]} · {demo.events.length}{" "}
              steps →
            </button>
          )
        }
        saved={(item) => (
          <button
            type="button"
            className="inline-flex items-center gap-1 self-start rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
            onClick={() => {
              setSelected(item.name);
              setTab("skills");
            }}
          >
            📘 Skill {item.verb}: {item.name}
          </button>
        )}
      />
    </Frame>
  );
}
