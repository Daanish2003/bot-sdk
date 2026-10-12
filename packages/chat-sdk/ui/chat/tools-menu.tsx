import type { McpMenuItem } from "../../core/client/mcp-tools";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { WrenchIcon } from "lucide-react";

/**
 * The composer's Tools menu: one switch per MCP server the user is connected to, off by default.
 * Renders nothing when there are no such servers.
 */
export function ToolsMenu({
  items,
  onToggle,
}: {
  items: McpMenuItem[];
  onToggle: (key: string, on: boolean) => void;
}) {
  if (items.length === 0) return null;
  const onCount = items.filter((item) => item.on).length;
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label="Tools"
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
          onCount > 0 ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
        )}
      >
        <WrenchIcon className="size-3.5" aria-hidden />
        Tools{onCount > 0 ? ` (${onCount})` : ""}
      </PopoverTrigger>
      <PopoverContent className="flex w-64 flex-col p-1">
        <ToolsMenuList items={items} onToggle={onToggle} />
      </PopoverContent>
    </Popover>
  );
}

/** The menu's items: one checkbox per MCP server, in the order the Host lists them. */
export function ToolsMenuList({
  items,
  onToggle,
}: {
  items: McpMenuItem[];
  onToggle: (key: string, on: boolean) => void;
}) {
  return (
    <ul aria-label="MCP servers" className="flex flex-col">
      {items.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={item.on}
            onClick={() => onToggle(item.key, !item.on)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
          >
            {item.name}
            <span className="text-xs text-muted-foreground">{item.on ? "On" : "Off"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
