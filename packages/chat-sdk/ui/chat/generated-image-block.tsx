import { type GeneratedImageErrorReason } from "../../core/shared/chat/generated-image";
import type { GeneratedImagePart } from "../../core/shared/message-parts";
import type { MessageKey } from "../../core/shared/i18n";
import { useI18n } from "../../core/client/react/provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  BanIcon,
  DownloadIcon,
  ImageIcon,
  SparklesIcon,
  TriangleAlertIcon,
  ZoomInIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

/**
 * An image an edit started from, as its chip shows it. A Generated image has an `imageId`, so the
 * chip has its thumbnail; an image Attachment has none and shows an icon.
 */
export type EditSource = { label: string; imageId?: string };

/** The dictionary key of each failed image's label (`generatedImageErrorLabels` is the Model's English). */
const generatedImageErrorKeys: Record<GeneratedImageErrorReason, MessageKey> = {
  refused: "chat.imageRefused",
  quota_exceeded: "chat.imageOverAllowance",
  limit_reached: "chat.imageLimitReached",
  too_many_images: "chat.imageTooManyToEdit",
  failed: "chat.imageFailed",
};

/**
 * One `generate_image` call of a reply (spec #278), at the shape it asked for. A running image is a
 * placeholder with a counter; a failed one says why; a stopped one says it was stopped. A finished
 * one is its picture, served by the owner's route under `imagesUrl`, with Zoom and Download. An
 * edit starts its caption with an "edited from" chip per source. To give images their own look,
 * edit this file in the Host's `ui/`; the SDK copy never overwrites it.
 */
export function GeneratedImageBlock({
  image,
  imagesUrl,
  editedFrom = [],
}: {
  image: GeneratedImagePart;
  /** Where the owner's route serves the image bytes: `<chat base>/generated-images`. */
  imagesUrl: string;
  /** The images this one was edited from, in the order the edit named them. */
  editedFrom?: EditSource[];
}) {
  const [zoomed, setZoomed] = useState(false);
  const { t } = useI18n();
  return (
    <figure className={cn("flex flex-col gap-1.5", shapeClass[image.aspectRatio])}>
      {image.state === "running" && <Placeholder image={image} />}
      {image.state === "error" && <Failure image={image} />}
      {image.state === "cancelled" && (
        <Box variant="muted">
          <BanIcon className="size-3.5 shrink-0" aria-hidden />
          <span>{t("chat.imageStopped")}</span>
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
              aria-label={t("chat.imageZoom")}
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
      <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground italic">
        {editedFrom.map((source, index) => (
          <EditedFromChip key={index} source={source} imagesUrl={imagesUrl} />
        ))}
        <span>{image.prompt}</span>
      </figcaption>
    </figure>
  );
}

/** The "edited from" chip: the source's thumbnail, or an icon, then its label (spec #278). */
function EditedFromChip({ source, imagesUrl }: { source: EditSource; imagesUrl: string }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted px-1.5 py-0.5 not-italic">
      {source.imageId ? (
        <img
          src={`${imagesUrl}/${source.imageId}`}
          alt=""
          className="size-5 shrink-0 rounded object-cover"
        />
      ) : (
        <ImageIcon className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="shrink-0">{t("chat.imageEditedFrom")}</span>
      <span className="truncate">{source.label}</span>
    </span>
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
  const { t } = useI18n();
  return (
    <a
      href={`${imagesUrl}/${image.imageId}?download=1`}
      download
      aria-label={t("chat.imageDownload")}
      className={buttonVariants({ variant: "secondary", size: label ? "sm" : "icon-sm" })}
    >
      <DownloadIcon />
      {label && t("chat.imageDownload")}
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
  const { t } = useI18n();
  return (
    <div
      role="status"
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-muted",
        ratioClass[image.aspectRatio],
      )}
    >
      <SparklesIcon className="size-5 animate-pulse text-muted-foreground" aria-hidden />
      <span className="text-xs text-muted-foreground">
        {t("chat.imageGenerating", { seconds })}
      </span>
    </div>
  );
}

function Failure({ image }: { image: GeneratedImagePart }) {
  const reason: GeneratedImageErrorReason = image.errorReason ?? "failed";
  const { t } = useI18n();
  return (
    <Box variant="error" role="alert">
      <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
      <span>{t(generatedImageErrorKeys[reason])}</span>
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
