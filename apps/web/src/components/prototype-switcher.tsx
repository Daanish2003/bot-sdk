// PROTOTYPE: throwaway variant switcher for UI prototypes (#542, reused by #663, #711, #734). Never merge to main.
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";

export function PrototypeSwitcher({
  variants,
  current,
  extra,
}: {
  variants: { key: string; name: string }[];
  current: string;
  extra?: ReactNode;
}) {
  const navigate = useNavigate();
  const index = Math.max(
    0,
    variants.findIndex((variant) => variant.key === current),
  );
  const go = (step: number) => {
    const next = variants[(index + step + variants.length) % variants.length];
    void navigate({
      to: ".",
      search: (prev: object) => ({ ...prev, variant: next.key }),
      replace: true,
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (import.meta.env.PROD) return null;
  const variant = variants[index];
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black px-3 py-1.5 text-sm text-white shadow-lg ring-2 ring-yellow-400">
      <button type="button" aria-label="Previous variant" onClick={() => go(-1)} className="px-1">
        ←
      </button>
      <span className="font-mono">
        {variant.key} ({variant.name})
      </span>
      <button type="button" aria-label="Next variant" onClick={() => go(1)} className="px-1">
        →
      </button>
      {extra}
    </div>
  );
}
