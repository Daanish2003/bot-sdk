// PROTOTYPE (#711) variant A, "In the thread": the Show me card sits in the thread like the
// Computer-use ask card (small live view, full screen on demand), collapses to a divider when done;
// the Skills list is a header popover beside Memory.
import { useState } from "react";

import { EventList, FakeScreen, Frame, RecDot, SkillEditor, statusText, Thread } from "./frame";
import type { Stub } from "./stub";

export const name = "In the thread";

export function VariantA({ stub }: { stub: Stub }) {
  const [full, setFull] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [popover, setPopover] = useState(false);
  const demo = stub.demo;
  const live = demo && (demo.status === "recording" || demo.status === "paused");

  const controls = live && (
    <div className="flex gap-2 text-xs">
      <button type="button" className="rounded-md border px-2 py-1" onClick={stub.pause}>
        {demo.status === "paused" ? "Resume" : "Pause"}
      </button>
      <button type="button" className="rounded-md border px-2 py-1" onClick={stub.cancel}>
        Cancel
      </button>
      <button
        type="button"
        className="rounded-md bg-primary px-2 py-1 text-primary-foreground"
        onClick={stub.done}
      >
        Done
      </button>
    </div>
  );

  return (
    <Frame
      header={
        <div className="relative">
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-xs"
            onClick={() => setPopover(!popover)}
          >
            Skills {stub.skills.length}
          </button>
          {popover && (
            <div className="absolute right-0 top-9 z-20 w-[28rem] rounded-lg border bg-background p-2 shadow-lg">
              <div className="flex items-center px-1 pb-2 text-xs text-muted-foreground">
                Planner reads a Skill only when a task needs it.
                <button
                  type="button"
                  className="ml-auto rounded-md border px-2 py-0.5"
                  onClick={stub.create}
                >
                  New Skill
                </button>
              </div>
              <ul className="flex max-h-[28rem] flex-col gap-1 overflow-auto">
                {stub.skills.map((s) => (
                  <li key={s.name} className="rounded-md border p-2">
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() => setOpen(open === s.name ? null : s.name)}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {s.name}
                        {s.problem && (
                          <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-900">
                            not usable
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {s.description || "(no description)"}
                      </div>
                    </button>
                    {open === s.name && (
                      <div className="mt-2">
                        <SkillEditor
                          skill={s}
                          onSave={(body) => stub.update(s.name, body)}
                          onDelete={() => stub.remove(s.name)}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      }
      overlay={
        full &&
        demo &&
        live && (
          <div className="absolute inset-0 z-30 flex flex-col bg-black/90 p-4">
            <div className="mb-2 flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white">
              <RecDot demo={demo} />
              {demo.status === "paused"
                ? "Paused. Sign in or type secrets now; the Bot sees nothing."
                : "Recording. Planner sees what you do on this Screen."}
              <span className="ml-auto font-mono">{stub.elapsed}</span>
              <button
                type="button"
                className="rounded bg-white/20 px-2"
                onClick={() => setFull(false)}
              >
                Shrink
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <FakeScreen demo={demo} big />
            </div>
            <div className="mt-2 flex justify-end [&_button]:bg-white [&_button]:text-black">
              {controls}
            </div>
          </div>
        )
      }
    >
      <Thread
        items={stub.items}
        demo={() =>
          demo &&
          (live ? (
            <div className="max-w-md rounded-xl border-2 border-red-500 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <RecDot demo={demo} /> Show me: {demo.goal}
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {stub.elapsed}
                </span>
              </div>
              <button type="button" className="block w-full" onClick={() => setFull(true)}>
                <FakeScreen demo={demo} />
              </button>
              <p className="my-2 text-xs text-muted-foreground">
                {demo.status === "paused"
                  ? "Paused: nothing is recorded. Resume when you're past the sign-in."
                  : "Planner sees what you do. Pause before typing a password."}
              </p>
              <EventList demo={demo} compact />
              <div className="mt-2 flex items-center">
                <button type="button" className="text-xs underline" onClick={() => setFull(true)}>
                  Full screen
                </button>
                <div className="ml-auto">{controls}</div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 self-center text-xs text-muted-foreground">
              <span className="h-px w-12 bg-border" />
              Show me · {demo.events.length} steps · {statusText[demo.status]}
              <span className="h-px w-12 bg-border" />
            </div>
          ))
        }
        saved={(item) => {
          const skill = stub.skills.find((s) => s.name === item.name);
          return (
            <div className="self-start text-xs text-muted-foreground">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                onClick={() => setOpen(open === `t:${item.name}` ? null : `t:${item.name}`)}
              >
                📘 Skill {item.verb}: {item.name}
              </button>
              {open === `t:${item.name}` && skill && (
                <div className="mt-1 w-[32rem] rounded-lg border p-2 text-foreground">
                  <SkillEditor
                    skill={skill}
                    onSave={(body) => stub.update(skill.name, body)}
                    onDelete={() => stub.remove(skill.name)}
                  />
                </div>
              )}
            </div>
          );
        }}
      />
    </Frame>
  );
}
