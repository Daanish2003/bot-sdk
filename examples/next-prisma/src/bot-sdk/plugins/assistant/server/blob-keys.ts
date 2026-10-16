/** The key of a Generated image's bytes (spec #278). */
export const generatedImageBlobKey = (imageId: string) => `generated-image/${imageId}`;

/** The key of a Knowledge file's original bytes (ADR 0014). */
export const knowledgeBlobKey = (fileId: string) => `knowledge/${fileId}`;
