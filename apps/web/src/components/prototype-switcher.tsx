// PROTOTYPE (#460): throwaway variant switcher. Never merge to main.
import { useEffect } from "react";

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
}: {
  variants: { key: string; name: string }[];
  current: string;
  onChange: (key: string) => void;
}) {
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const step = (by: number) =>
    onChange(variants[(index + by + variants.length) % variants.length]!.key);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      )
        return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;
  const v = variants[index]!;
  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-full bg-black px-4 py-2 text-sm text-white shadow-lg ring-2 ring-yellow-400">
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">
        ←
      </button>
      <span className="font-mono">
        {v.key} ({v.name})
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">
        →
      </button>
    </div>
  );
}
