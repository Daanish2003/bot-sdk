import {
  generatedImageErrorLabels,
  type GeneratedImageErrorReason,
} from "../../core/shared/chat/generated-image";
import type { GeneratedImagePart } from "../../core/shared/message-parts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { BanIcon, DownloadIcon, SparklesIcon, TriangleAlertIcon, ZoomInIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

/**
 * One `generate_image` call of a reply (spec #278), at the shape it asked for. A running image is a
 * placeholder with a counter; a failed one says why; a stopped one says it was stopped. A finished
 * one is its picture, served by the owner's route under `imagesUrl`, with Zoom and Download. To give
 * images their own look, edit this file in the Host's `ui/`; the SDK copy never overwrites it.
 */
export function GeneratedImageBlock({
  image,
  imagesUrl,
}: {
  image: GeneratedImagePart;
  /** Where the owner's route serves the image bytes: `<chat base>/generated-images`. */
  imagesUrl: string;
}) {
  const [zoomed, setZoomed] = useState(false);
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
      {image.state === "done" && image.imageId && (
        <div className="group relative overflow-hidden rounded-xl bg-muted">
          <img
            src={`${imagesUrl}/${image.imageId}`}
            alt={image.prompt}
            className="block h-auto w-full"
          />
          <div className="absolute top-2 right-2 flex gap-1 opacity-100 transition-opacity [@media(hover:hover)_and_(min-width:768px)]:opacity-0 [@media(hover:hover)_and_(min-width:768px)]:group-hover:opacity-100 [@media(hover:hover)_and_(min-width:768px)]:focus-within:opacity-100">
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Zoom"
              onClick={() => setZoomed(true)}
            >
              <ZoomInIcon />
            </Button>
            <DownloadLink imagesUrl={imagesUrl} image={image} />
          </div>
          <Dialog open={zoomed} onOpenChange={setZoomed}>
            <DialogContent className="sm:max-w-[min(90vw,64rem)]">
              <DialogTitle className="sr-only">{image.prompt}</DialogTitle>
              <GeneratedImageViewer image={image} imagesUrl={imagesUrl} />
            </DialogContent>
          </Dialog>
        </div>
      )}
      <figcaption className="text-xs text-muted-foreground italic">{image.prompt}</figcaption>
    </figure>
  );
}

/**
 * A finished image as the lightbox shows it: as large as fits, with its prompt and a Download. The
 * download asks the owner's route for the file under its own name.
 */
export function GeneratedImageViewer({
  image,
  imagesUrl,
}: {
  image: GeneratedImagePart;
  imagesUrl: string;
}) {
  if (!image.imageId) return null;
  return (
    <div className="flex flex-col gap-3">
      <img
        src={`${imagesUrl}/${image.imageId}`}
        alt={image.prompt}
        className="max-h-[75vh] w-full object-contain"
      />
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground italic">{image.prompt}</p>
        <DownloadLink imagesUrl={imagesUrl} image={image} label />
      </div>
    </div>
  );
}

/** The image's bytes as a file download (`?download=1`), named for saving. */
function DownloadLink({
  imagesUrl,
  image,
  label = false,
}: {
  imagesUrl: string;
  image: GeneratedImagePart;
  label?: boolean;
}) {
  return (
    <a
      href={`${imagesUrl}/${image.imageId}?download=1`}
      download
      aria-label="Download"
      className={buttonVariants({ variant: "secondary", size: label ? "sm" : "icon-sm" })}
    >
      <DownloadIcon />
      {label && "Download"}
    </a>
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
