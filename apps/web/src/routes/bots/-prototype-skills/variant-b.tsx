// PROTOTYPE (#711) variant B, "Studio": a Demonstration takes the whole page: the Screen large on
// the left, "What Planner sees" on the right, and after Done the drafted SKILL.md beside it to edit
// before going back to chat. The Skills list is a full page with a list and an editor.
import { useState } from "react";

import { EventList, FakeScreen, Frame, RecDot, SkillEditor, statusText, Thread } from "./frame";
import type { Stub } from "./stub";

export const name = "Studio";

export function VariantB({ stub }: { stub: Stub }) {
  const [studio, setStudio] = useState(true);
  const [page, setPage] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const demo = stub.demo;
  const showStudio = demo && studio && demo.status !== "cancelled";

  if (page) {
    const skill = stub.skills.find((s) => s.name === selected) ?? stub.skills[0];
    return (
      <div className="flex h-dvh flex-col bg-background">
        <header className="flex items-center gap-2 border-b px-4 py-2">
          <button type="button" className="text-sm" onClick={() => setPage(false)}>
            ← Planner
          </button>
          <span className="font-semibold">Skills</span>
          <span className="text-xs text-muted-foreground">
            Files in Planner's skills/ folder. Planner reads one only when a task needs it.
          </span>
          <button
            type="button"
            className="ml-auto rounded-md border px-2 py-1 text-xs"
            onClick={stub.create}
          >
            New Skill
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <ul className="w-80 shrink-0 overflow-auto border-r">
            {stub.skills.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  className={`w-full border-b px-3 py-2 text-left ${skill?.name === s.name ? "bg-muted" : ""}`}
                  onClick={() => setSelected(s.name)}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {s.name}
                    {s.problem && (
                      <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-900">
                        not usable
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {s.description || "(no description)"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    by {s.savedBy} · {s.updatedAt}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex-1 overflow-auto p-4">
            {skill && (
              <SkillEditor
                key={skill.name}
                skill={skill}
                onSave={(body) => stub.update(skill.name, body)}
                onDelete={() => stub.remove(skill.name)}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  if (showStudio) {
    const live = demo.status === "recording" || demo.status === "paused";
    const skill = stub.skills.find((s) => s.name === demo.skillName);
    return (
      <div className="flex h-dvh flex-col bg-neutral-950 text-white">
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2 text-sm">
          <RecDot demo={demo} />
          <span className="font-medium">Show Planner: {demo.goal}</span>
          <span className="text-white/60">{statusText[demo.status]}</span>
          <span className="font-mono text-white/60">{stub.elapsed}</span>
          <div className="ml-auto flex gap-2 text-xs">
            {live && (
              <>
                <button
                  type="button"
                  className="rounded-md bg-white/10 px-3 py-1"
                  onClick={stub.pause}
                >
                  {demo.status === "paused" ? "Resume" : "Pause for a sign-in"}
                </button>
                <button
                  type="button"
                  className="rounded-md bg-white/10 px-3 py-1"
                  onClick={stub.cancel}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-md bg-red-600 px-3 py-1"
                  onClick={stub.done}
                >
                  Done
                </button>
              </>
            )}
            {!live && (
              <button
                type="button"
                className="rounded-md bg-white/10 px-3 py-1"
                onClick={() => setStudio(false)}
              >
                Back to chat
              </button>
            )}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 gap-3 p-3">
          <div className="min-w-0 flex-[3]">
            <FakeScreen demo={demo} big />
          </div>
          <div className="flex min-w-0 flex-[2] flex-col gap-3 overflow-auto rounded-lg bg-white/5 p-3">
            <div className="text-xs text-white/60">
              Inputs: {demo.inputs.join(", ")} · Password fields are masked; nothing is seen while
              paused.
            </div>
            <div className="text-sm font-medium">What Planner sees</div>
            <EventList demo={demo} />
            {demo.status === "drafting" && (
              <div className="text-sm text-white/70">Planner is writing the Skill…</div>
            )}
            {demo.status === "saved" && skill && (
              <div className="rounded-lg bg-white p-2 text-black">
                <div className="mb-1 text-sm font-medium">Saved. Change anything?</div>
                <SkillEditor
                  skill={skill}
                  onSave={(body) => stub.update(skill.name, body)}
                  onDelete={() => stub.remove(skill.name)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Frame
      header={
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs"
          onClick={() => setPage(true)}
        >
          Skills {stub.skills.length}
        </button>
      }
    >
      <Thread
        items={stub.items}
        demo={() =>
          demo && (
            <button
              type="button"
              className="flex items-center gap-2 self-center rounded-full border px-3 py-1 text-xs"
              onClick={() => setStudio(true)}
            >
              <RecDot demo={demo} /> Show me · {demo.events.length} steps ·{" "}
              {statusText[demo.status]} · open
            </button>
          )
        }
        saved={(item) => (
          <button
            type="button"
            className="self-start text-xs text-muted-foreground underline"
            onClick={() => {
              setSelected(item.name);
              setPage(true);
            }}
          >
            📘 Skill {item.verb}: {item.name}
          </button>
        )}
      />
    </Frame>
  );
}
