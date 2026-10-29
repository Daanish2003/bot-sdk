import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BotCheckIn } from "@botsdk/client/bot/check-in";
import {
  type BotRoutine,
  type RoutineDay,
  type RoutineSchedule,
  routineDays,
} from "@botsdk/client/bot/routine";
import { type FormEvent, useState } from "react";

import { useI18n } from "@botsdk/react/provider";
import { useRefusalToast } from "./refusal-toast";

const dayKeys = {
  mon: "bots.dayMon",
  tue: "bots.dayTue",
  wed: "bots.dayWed",
  thu: "bots.dayThu",
  fri: "bots.dayFri",
  sat: "bots.daySat",
  sun: "bots.daySun",
} as const;

/** What the user's edit of a Routine sends: only what changed. */
export type RoutineEdit = { routineId: string; prompt?: string; schedule?: RoutineSchedule };

/** What the user's edit of a Check-in sends: only what changed. */
export type CheckInEdit = { checkInId: string; at?: Date; note?: string };

/**
 * The small inline form that edits a Routine's prompt and, unless it runs on a webhook, its days and
 * time (spec #1007). Save sends only what changed, and closes the form once the server accepts it;
 * a refusal says why in a toast and keeps the form.
 */
export function RoutineEditForm({
  routine,
  onEdit,
  onClose,
  busy,
}: {
  routine: BotRoutine;
  onEdit: (edit: RoutineEdit) => Promise<void>;
  onClose: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const run = useRefusalToast();
  const [prompt, setPrompt] = useState(routine.prompt);
  const [days, setDays] = useState<readonly RoutineDay[]>(routine.schedule?.days ?? []);
  const [at, setAt] = useState(routine.schedule?.at ?? "");
  const schedule = routine.schedule;
  const scheduleChanged =
    schedule !== null &&
    (at !== schedule.at ||
      routineDays.some((day) => days.includes(day) !== schedule.days.includes(day)));
  const promptChanged = prompt.trim() !== routine.prompt;
  const valid = prompt.trim() !== "" && (schedule === null || (days.length > 0 && at !== ""));
  const toggle = (day: RoutineDay) =>
    setDays((current) =>
      current.includes(day) ? current.filter((one) => one !== day) : [...current, day],
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    if (!promptChanged && !scheduleChanged) return onClose();
    run(
      onEdit({
        routineId: routine.id,
        ...(promptChanged && { prompt: prompt.trim() }),
        ...(scheduleChanged && {
          schedule: { days: routineDays.filter((day) => days.includes(day)), at },
        }),
      }).then(onClose),
    );
  };
  return (
    <form
      data-edit-routine={routine.id}
      onSubmit={submit}
      aria-label={t("bots.editRoutine", { name: routine.name })}
      className="flex flex-col gap-2 pl-6"
    >
      <Textarea
        aria-label={t("bots.routinePrompt")}
        value={prompt}
        disabled={busy}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {schedule && (
        <div className="flex flex-wrap items-center gap-1">
          {routineDays.map((day) => (
            <Button
              key={day}
              type="button"
              size="xs"
              variant={days.includes(day) ? "secondary" : "ghost"}
              aria-pressed={days.includes(day)}
              disabled={busy}
              onClick={() => toggle(day)}
            >
              {t(dayKeys[day])}
            </Button>
          ))}
          <Input
            type="time"
            aria-label={t("bots.routineTime")}
            className="ml-auto w-28"
            value={at}
            disabled={busy}
            onChange={(event) => setAt(event.target.value)}
          />
        </div>
      )}
      <div className="flex justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          {t("bots.cancel")}
        </Button>
        <Button type="submit" size="xs" disabled={busy || !valid}>
          {t("bots.save")}
        </Button>
      </div>
    </form>
  );
}

/** `at` as a `datetime-local` field holds it: its local date and time to the minute. */
function localInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * The small inline form that moves a pending Check-in or changes its note. Save sends only what
 * changed; the server refuses a Check-in that has already fired.
 */
export function CheckInEditForm({
  checkIn,
  onEdit,
  onClose,
  busy,
}: {
  checkIn: BotCheckIn;
  onEdit: (edit: CheckInEdit) => Promise<void>;
  onClose: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const run = useRefusalToast();
  const initial = localInput(checkIn.at);
  const [time, setTime] = useState(initial);
  const [note, setNote] = useState(checkIn.note);
  const at = new Date(time);
  const atChanged = time !== initial;
  const noteChanged = note.trim() !== checkIn.note;
  const valid = !Number.isNaN(at.getTime()) && note.trim() !== "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    if (!atChanged && !noteChanged) return onClose();
    run(
      onEdit({
        checkInId: checkIn.id,
        ...(atChanged && { at }),
        ...(noteChanged && { note: note.trim() }),
      }).then(onClose),
    );
  };
  return (
    <form
      data-edit-check-in={checkIn.id}
      onSubmit={submit}
      aria-label={t("bots.editCheckIn")}
      className="flex flex-col gap-2 pl-6"
    >
      <Input
        type="datetime-local"
        aria-label={t("bots.checkInTime")}
        value={time}
        disabled={busy}
        onChange={(event) => setTime(event.target.value)}
      />
      <Input
        aria-label={t("bots.checkInNote")}
        value={note}
        disabled={busy}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          {t("bots.cancel")}
        </Button>
        <Button type="submit" size="xs" disabled={busy || !valid}>
          {t("bots.save")}
        </Button>
      </div>
    </form>
  );
}
