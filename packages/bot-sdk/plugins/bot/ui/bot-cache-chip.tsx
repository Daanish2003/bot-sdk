import { useState } from "react";

import { useI18n } from "../../../core/client/react/provider";
import type { BotTurnStep } from "../shared/turn";

type CacheState = "read" | "written" | "missed" | "notCached";

const stateClass = {
  read: "bg-emerald-500",
  written: "bg-sky-500",
  missed: "bg-red-500",
  notCached: "bg-muted-foreground/30",
} as const satisfies Record<CacheState, string>;

const stateKey = {
  read: "bots.cacheRead",
  written: "bots.cacheWritten",
  missed: "bots.cacheMissed",
  notCached: "bots.cacheNotCached",
} as const satisfies Record<CacheState, string>;

const costOf = (micros: number) => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;

const percentOf = (steps: BotTurnStep[]) => {
  const input = steps.reduce((sum, step) => sum + step.inputTokens, 0);
  const read = steps.reduce((sum, step) => sum + step.cacheReadTokens, 0);
  return input === 0 ? 0 : Math.min(100, Math.round((read / input) * 100));
};

/**
 * What the cache did to each section of the Step's prompt. The sections' sizes are estimates, so the
 * Provider's read and written counts are laid over them as fractions of the input. The section
 * flagged as a bug is a miss; the rest follow their place in the prompt.
 */
function sectionStates(step: BotTurnStep): CacheState[] {
  const total = step.sections.reduce((sum, section) => sum + section.tokens, 0);
  const readEnd = step.inputTokens === 0 ? 0 : (step.cacheReadTokens / step.inputTokens) * total;
  const writeEnd =
    step.inputTokens === 0
      ? 0
      : ((step.cacheReadTokens + step.cacheWriteTokens) / step.inputTokens) * total;
  let start = 0;
  return step.sections.map((section) => {
    const middle = start + section.tokens / 2;
    start += section.tokens;
    if (step.changed?.kind === "bug" && step.changed.section === section.name) return "missed";
    if (middle < readEnd) return "read";
    return middle < writeEnd ? "written" : "notCached";
  });
}

function StepDetail({ step, number }: { step: BotTurnStep; number: number }) {
  const { t } = useI18n();
  const states = sectionStates(step);
  const total = step.sections.reduce((sum, section) => sum + section.tokens, 0) || 1;
  return (
    <li className="flex flex-col gap-1">
      <div className="text-muted-foreground">
        {t("bots.cacheStep", {
          number,
          percent: percentOf([step]),
          cost: costOf(step.costMicros),
        })}
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded" aria-hidden>
        {step.sections.map((section, index) => (
          <div
            key={index}
            className={`${stateClass[states[index]!]} border-r border-background/60`}
            style={{ width: `${Math.max(1.5, (section.tokens / total) * 100)}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-col">
        {step.sections.map((section, index) => (
          <li
            key={index}
            className={`flex gap-2 ${states[index] === "missed" ? "text-red-600" : ""}`}
          >
            <span className="flex-1">
              {section.name} · {t(stateKey[states[index]!])}
            </span>
            <span className="tabular-nums">{section.tokens}</span>
            <span className="font-mono">
              {section.was ? `#${section.was.slice(0, 6)} → ` : ""}#{section.hash.slice(0, 6)}
            </span>
          </li>
        ))}
      </ul>
      {step.changed && (
        <p className={step.changed.kind === "bug" ? "text-red-600" : undefined}>
          {t(step.changed.kind === "bug" ? "bots.cacheBug" : "bots.cacheExpected", {
            section: step.changed.section,
          })}
        </p>
      )}
    </li>
  );
}

/**
 * The cache chip under a Turn (#675, prototype variant A with B's bars): how much of its input came
 * from the cache, its Steps and cost, red when a section changed that should not have. It expands to
 * each Step's prompt as a bar of sections sized by tokens, with every section's hash. Shows nothing
 * for a Turn with no Steps.
 */
export function BotCacheChip({ steps }: { steps: BotTurnStep[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const bug = steps.find((step) => step.changed?.kind === "bug");
  const cost = costOf(steps.reduce((sum, step) => sum + step.costMicros, 0));
  return (
    <div className="self-start text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${bug ? "border-red-400 text-red-600" : ""}`}
        onClick={() => setOpen(!open)}
      >
        {bug
          ? t("bots.cacheMiss", { section: bug.changed!.section, steps: steps.length, cost })
          : t("bots.cacheChip", { percent: percentOf(steps), steps: steps.length, cost })}
      </button>
      {open && (
        <ol className="mt-1 flex flex-col gap-3 rounded-lg border p-2">
          {steps.map((step, index) => (
            <StepDetail key={step.id} step={step} number={index + 1} />
          ))}
        </ol>
      )}
    </div>
  );
}
