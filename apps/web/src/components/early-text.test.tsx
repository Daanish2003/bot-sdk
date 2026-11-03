import { Input } from "@ai-chat/ui/components/input";
import { Textarea } from "@ai-chat/ui/components/textarea";
import { act, type ComponentProps, createRef, useState } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

/** A form whose state drives a controlled field, as the app's forms do. */
function Form({
  Control,
  initial = "",
  onChange,
}: {
  Control: (props: ComponentProps<"input"> & ComponentProps<"textarea">) => React.ReactNode;
  initial?: string;
  onChange?: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <>
      <Control
        data-testid="field"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange?.(event.target.value);
        }}
      />
      <output>{text}</output>
    </>
  );
}

/** Renders on the server, lets someone type into that HTML, then hydrates it. */
async function hydrateAfterTyping(form: React.ReactElement, typed?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = renderToString(form);
  const field = container.querySelector<HTMLInputElement>("[data-testid=field]")!;
  if (typed !== undefined) field.value = typed;
  await act(async () => {
    root = hydrateRoot(container, form);
  });
  return { field, state: container.querySelector("output")! };
}

const controls = { Input, Textarea } as Record<
  string,
  (props: ComponentProps<"input"> & ComponentProps<"textarea">) => React.ReactNode
>;

describe.each(Object.keys(controls))("%s hydrated over text typed early", (name) => {
  const Control = controls[name]!;

  it("hands the text to the form's state, and keeps it on screen", async () => {
    const { field, state } = await hydrateAfterTyping(<Form Control={Control} />, "Early");

    expect(state.textContent).toBe("Early");
    expect(field.value).toBe("Early");
  });

  it("goes on taking typing afterwards", async () => {
    const { field, state } = await hydrateAfterTyping(<Form Control={Control} />, "Early");

    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(
        field,
        "Early and late",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(state.textContent).toBe("Early and late");
    expect(field.value).toBe("Early and late");
  });

  it("calls nobody when nothing was typed", async () => {
    const onChange = vi.fn();
    const { field, state } = await hydrateAfterTyping(
      <Form Control={Control} initial="Saved" onChange={onChange} />,
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(state.textContent).toBe("Saved");
    expect(field.value).toBe("Saved");
  });
});

it("still passes a caller's ref to the element", async () => {
  const inputRef = createRef<HTMLInputElement>();
  const textareaRef = createRef<HTMLTextAreaElement>();
  const form = (
    <>
      <Input ref={inputRef} />
      <Textarea ref={textareaRef} />
    </>
  );
  const container = document.createElement("div");
  document.body.append(container);
  container.innerHTML = renderToString(form);
  await act(async () => {
    root = hydrateRoot(container, form);
  });

  expect(inputRef.current?.tagName).toBe("INPUT");
  expect(textareaRef.current?.tagName).toBe("TEXTAREA");
});
