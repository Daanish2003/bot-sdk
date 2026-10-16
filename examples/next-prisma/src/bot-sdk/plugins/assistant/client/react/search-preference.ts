import { useEffect, useState } from "react";

const storageKey = "ai-chat:web-search";

/** Set this page session; storage may be blocked. */
let chosen: boolean | undefined;

/** Whether the user wants Search on, remembered in `localStorage` for this browser; on by default. */
export function readSearchPreference() {
  if (chosen !== undefined) return chosen;
  try {
    return localStorage.getItem(storageKey) !== "off";
  } catch {
    return true;
  }
}

/**
 * `readSearchPreference` as state, read after mounting so the server render and the first client
 * render agree.
 */
export function useSearchPreference() {
  const [on, setOn] = useState(true);
  useEffect(() => setOn(readSearchPreference()), []);
  const set = (value: boolean) => {
    chosen = value;
    setOn(value);
    try {
      localStorage.setItem(storageKey, value ? "on" : "off");
    } catch {
      // Storage blocked: remembered for this page session only.
    }
  };
  return [on, set] as const;
}
