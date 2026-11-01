/**
 * What a Bot header popover's trigger carries so the phone's "⋯" menu can open it (spec #1117).
 * On a phone the trigger is invisible (out of the tab order and the accessibility tree) but still
 * laid out over the "⋯" button, so its popover opens there; the menu lists every such trigger in
 * its header and clicks the one chosen. From 768 px up it is the visible button it always was.
 */
export const headerPopoverTrigger = (name: string) => ({
  "data-header-popover": name,
  className:
    "md:relative max-md:invisible max-md:absolute max-md:top-0 max-md:right-0 max-md:size-8 max-md:overflow-hidden",
});
