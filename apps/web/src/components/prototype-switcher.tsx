/*
 * PROTOTYPE, throw away (#1039, #1043). The floating variant bar shared by the two Messaging
 * Channels prototypes: ←/→ or the arrows cycle `?variant=`, and the last action shows above it.
 */
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect } from "react";

export function PrototypeSwitcher<K extends string>({
  ticket,
  variants,
  current,
  last,
}: {
  ticket: string;
  variants: Record<K, string>;
  current: K;
  last?: string;
}) {
  const navigate = useNavigate();
  const keys = Object.keys(variants) as K[];
  const go = (step: number) => {
    const next = keys[(keys.indexOf(current) + step + keys.length) % keys.length];
    void navigate({
      to: ".",
      // Prototype: each host route types its own `variant`.
      search: ((prev: object) => ({ ...prev, variant: next })) as never,
      replace: true,
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (process.env.NODE_ENV === "production") return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-1">
      {last && (
        <div className="rounded bg-black/70 px-2 py-0.5 text-xs text-white">Last: {last}</div>
      )}
      <div className="flex items-center gap-2 rounded-full bg-fuchsia-600 px-3 py-1 text-sm text-white shadow-lg">
        <button type="button" aria-label="Previous variant" onClick={() => go(-1)}>
          <ChevronLeftIcon className="size-4" />
        </button>
        PROTOTYPE {ticket} · {current} ({variants[current]})
        <button type="button" aria-label="Next variant" onClick={() => go(1)}>
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
