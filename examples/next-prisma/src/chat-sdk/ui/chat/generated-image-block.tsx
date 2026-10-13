import {
  generatedImageErrorLabels,
  type GeneratedImageErrorReason,
} from "../../core/shared/chat/generated-image";
import type { GeneratedImagePart } from "../../core/shared/message-parts";
import { cn } from "@/lib/utils";
import { BanIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

/**
 * One `generate_image` call of a reply (spec #278), at the shape it asked for. A running image is a
 * placeholder with a counter; a failed one says why; a stopped one says it was stopped. The finished
 * picture is shown once the image's bytes are stored (its own ticket): until then a done image shows
 * its prompt only. To give images their own look, edit this file in the Host's `ui/`; the SDK copy
 * never overwrites it.
 */
export function GeneratedImageBlock({ image }: { image: GeneratedImagePart }) {
  return (
    <figure className={cn("flex flex-col gap-1.5", shapeClass[image.aspectRatio])}>
      {image.state === "running" && <Placeholder image={image} />}
      {image.state === "error" && <Failure image={image} />}
      {image.state === "cancelled" && (
        <Box variant="muted">
          <BanIcon className="size-3.5 shrink-0" aria-hidden />
          <span>Stopped before the image was ready</span>
        </Box>
      )}
      <figcaption className="text-xs text-muted-foreground italic">{image.prompt}</figcaption>
    </figure>
  );
}

/** The width each shape is drawn at, so the placeholder and the picture take the same room. */
const shapeClass: Record<GeneratedImagePart["aspectRatio"], string> = {
  square: "max-w-md",
  landscape: "max-w-md",
  portrait: "max-w-64",
};

const ratioClass: Record<GeneratedImagePart["aspectRatio"], string> = {
  square: "aspect-square",
  landscape: "aspect-[3/2]",
  portrait: "aspect-[2/3]",
};

function Placeholder({ image }: { image: GeneratedImagePart }) {
  const seconds = useElapsedSeconds();
  return (
    <div
      role="status"
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-muted",
        ratioClass[image.aspectRatio],
      )}
    >
      <SparklesIcon className="size-5 animate-pulse text-muted-foreground" aria-hidden />
      <span className="text-xs text-muted-foreground">Generating image · {seconds}s</span>
    </div>
  );
}

function Failure({ image }: { image: GeneratedImagePart }) {
  const reason: GeneratedImageErrorReason = image.errorReason ?? "failed";
  return (
    <Box variant="error" role="alert">
      <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
      <span>{generatedImageErrorLabels[reason]}</span>
    </Box>
  );
}

function Box({
  variant,
  children,
  role,
}: {
  variant: "muted" | "error";
  children: ReactNode;
  role?: string;
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex items-center gap-2 rounded-xl border border-dashed p-3 text-xs",
        variant === "error" ? "border-destructive/50 text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** Whole seconds since the placeholder mounted, counting up once a second. */
function useElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return seconds;
}
