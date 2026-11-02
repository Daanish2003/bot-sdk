import { describe, expect, it } from "vitest";

import type { BotAssignment } from "../../src/bot/assignment";
import { type BotTasks, type TaskTrigger, taskCount } from "../../src/bot/tasks";

const at = new Date("2026-11-02T09:00:00.000Z");

const assignment = { id: "a1", status: "working" } as BotAssignment;

const trigger = (id: string) => ({ id, source: "assignment" }) as TaskTrigger;

const tasks = ({
  turn = false,
  assignments = [assignment],
  triggers = [],
}: {
  turn?: boolean;
  assignments?: BotAssignment[];
  triggers?: TaskTrigger[];
}) =>
  ({
    inProgress: {
      turn: turn ? { id: "t1", startedAt: at, conversationId: "c1" } : null,
      helpers: [],
      assignments,
    },
    scheduled: { triggers, routines: [], checkIns: [] },
  }) as BotTasks;

describe("the Tasks count with Assignments", () => {
  it("counts a working Assignment that nothing else shows, so the header is not 0", () => {
    expect(taskCount(tasks({}))).toBe(1);
    expect(taskCount(tasks({ assignments: [assignment, { ...assignment, id: "a2" }] }))).toBe(2);
  });

  it("does not count it twice beside a running Turn", () => {
    expect(taskCount(tasks({ turn: true }))).toBe(1);
  });

  it("does not count it twice beside its waiting Trigger, first or afresh", () => {
    expect(taskCount(tasks({ triggers: [trigger("assignment:a1")] }))).toBe(1);
    expect(taskCount(tasks({ triggers: [trigger("assignment:a1:0190")] }))).toBe(1);
    expect(taskCount(tasks({ triggers: [trigger("assignment:a2")] }))).toBe(2);
  });
});
