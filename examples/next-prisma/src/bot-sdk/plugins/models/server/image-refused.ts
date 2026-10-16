/**
 * An image the Provider's safety filter refused (spec #278). An image adapter throws it, so the
 * `generate_image` call is stored as `refused` rather than `failed`.
 */
export class ImageRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRefusedError";
  }
}
