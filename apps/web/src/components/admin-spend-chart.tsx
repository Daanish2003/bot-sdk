import type { DaySpend } from "@/admin/spend";
import { formatUsd } from "@/admin/users";

/**
 * Spend per day over the window, one column a day, split by Model (spec #277). Each Model takes
 * one of the chart colors, in the order the Models are listed.
 */
export function AdminSpendChart({ days, models }: { days: DaySpend[]; models: string[] }) {
  const total = days.reduce((sum, day) => sum + day.totalMicros, 0);
  const peak = Math.max(1, ...days.map((day) => day.totalMicros));
  const color = (index: number) => `var(--chart-${(index % 5) + 1})`;

  return (
    <figure className="space-y-3">
      <div
        role="img"
        aria-label={`Spend per day, last ${days.length} days: ${formatUsd(total)} in total`}
        className="flex h-48 items-end gap-1 rounded-md border p-3"
      >
        {days.map((day) => (
          <div
            key={day.day}
            title={`${day.day}: ${formatUsd(day.totalMicros)}`}
            className="flex flex-1 flex-col-reverse overflow-hidden rounded-sm"
            style={{ height: `${(day.totalMicros / peak) * 100}%` }}
          >
            {models.map((model, index) =>
              day.byModel[model] ? (
                <div
                  key={model}
                  style={{
                    height: `${(day.byModel[model] / day.totalMicros) * 100}%`,
                    background: color(index),
                  }}
                />
              ) : null,
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{days[0]?.day}</span>
        <span>{days.at(-1)?.day}</span>
      </div>
      {models.length > 0 ? (
        <figcaption className="flex flex-wrap gap-4 text-sm">
          {models.map((model, index) => (
            <span key={model} className="inline-flex items-center gap-2">
              <span className="size-3 rounded-sm" style={{ background: color(index) }} />
              {model}
            </span>
          ))}
        </figcaption>
      ) : (
        <p className="text-sm text-muted-foreground">No spend in the last 30 days.</p>
      )}
    </figure>
  );
}
