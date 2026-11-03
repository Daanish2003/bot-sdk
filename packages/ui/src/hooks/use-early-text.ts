import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

/**
 * Keeps text entered in a controlled field before the page hydrated (#1242). The server's HTML can
 * be typed in, or filled by a password manager, before React takes over. Hydration leaves that text
 * in the DOM but marks it as already seen, so no `onChange` fires, the state stays behind, and the
 * next render wipes the field. On mount, this sends such text through `onChange`.
 *
 * Takes the field's `value` and the caller's `ref`; returns the ref to put on the element.
 */
export function useEarlyText<T extends HTMLInputElement | HTMLTextAreaElement>(
  value: unknown,
  ref: Ref<T> | undefined,
) {
  const own = useRef<T>(null);
  useImperativeHandle(ref, () => own.current as T, [ref]);

  useEffect(() => {
    const field = own.current;
    if (!field || value == null || field.value === String(value)) return;
    const early = field.value;
    // React compares a change event with the last value it saw through the element's own setter.
    // So it's told the state's value that way, and the text returns through the prototype's.
    field.value = String(value);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set?.call(field, early);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    // Mount only: after that, the field's value changes through React.
  }, []);

  return own;
}
