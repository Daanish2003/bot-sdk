import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";
import { useId } from "react";

/**
 * The one design of the cards that wait on the user's decision, or on a typed answer (spec #1117):
 * Approval, Routine, Rule and Secret. A plain outlined box at the column's width, with a title, its
 * status and the actions. `attention` is for an Approval waiting on the user: an amber border. The
 * body scrolls in its own box when long (`max-h-60`), so the actions, which sit outside it, stay in
 * view in a long thread. Pass `data-*` attributes to mark the card; to make it a form, wrap it in a `<form className="contents">`.
 * A Host's own card (`controls`) replaces the whole card, so this draws no state of its own.
 */
export function ApprovalCard({
  title,
  icon,
  status,
  attention = false,
  children,
  actions,
  foot,
  className,
  ...rest
}: {
  title: ReactNode;
  icon?: ReactNode;
  /** One muted line under the title: a schedule, a mode, a countdown. */
  status?: ReactNode;
  attention?: boolean;
  /** What the card is about. Scrolls inside the card when long. */
  children?: ReactNode;
  /** The card's buttons; they never scroll away. */
  actions: ReactNode;
  /** Full-width content under the actions, such as a countdown bar. */
  foot?: ReactNode;
} & Omit<ComponentProps<"div">, "title" | "children" | "ref">) {
  const titleId = useId();
  return (
    <div
      {...rest}
      role="group"
      aria-labelledby={titleId}
      data-approval-card=""
      className={cn(
        "flex w-full flex-col gap-2 overflow-hidden rounded-xl border pt-3 text-sm",
        attention ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30" : "border-border bg-card",
        className,
      )}
    >
      <div className="px-3">
        <div id={titleId} data-approval-title="" className="flex items-center gap-2 font-medium">
          {icon}
          {title}
        </div>
      </div>
      {(status || children) && (
        <div
          data-approval-body=""
          className="flex max-h-60 min-h-0 flex-col gap-2 overflow-y-auto px-3 py-0.5"
        >
          {status && <div className="text-xs text-muted-foreground">{status}</div>}
          {children}
        </div>
      )}
      <div data-approval-actions="" className="flex shrink-0 items-center gap-2 px-3 pb-3">
        {actions}
      </div>
      {foot && <div className="-mt-2">{foot}</div>}
    </div>
  );
}

/**
 * A settled card, collapsed to its one line (spec #1117): an icon and a sentence between two rules,
 * the same for every card and every in-thread note. `tone` colours the icon. `actions` are for a
 * line that still has something to do, such as pausing an approved Routine.
 */
export function SettledLine({
  icon,
  tone,
  actions,
  children,
  ...rest
}: {
  icon: ReactNode;
  tone?: string;
  actions?: ReactNode;
} & Omit<ComponentProps<"div">, "children"> & { children: ReactNode }) {
  return (
    <div
      {...rest}
      data-approval-settled=""
      className="flex w-full items-center gap-2 text-xs text-muted-foreground"
    >
      <span className="h-px flex-1 bg-border" />
      <span className={cn("inline-flex min-w-0 items-center gap-1", tone)}>
        {icon}
        <span className="min-w-0 break-words text-muted-foreground">{children}</span>
      </span>
      {actions}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
