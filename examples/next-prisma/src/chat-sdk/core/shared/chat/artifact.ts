/**
 * An Artifact (CONTEXT.md, ADR 0016): a piece of content the assistant makes in a Conversation.
 * Shared by the server (the tool, the store) and the browser (the card, the panel's downloads).
 */

/** The kinds of Artifact, which decide how the panel shows one (spec #304). */
export const artifactKinds = ["code", "markdown", "html", "svg", "mermaid"] as const;
export type ArtifactKind = (typeof artifactKinds)[number];

/** The `create_artifact` tool, as the Model sees it. */
export const createArtifactToolName = "create_artifact";

/** The `update_artifact` tool, as the Model sees it (ADR 0016). */
export const updateArtifactToolName = "update_artifact";

/** The most content one version may hold (zod counts characters, which is bytes for ASCII). */
export const maxArtifactContent = 256 * 1024;

/** File extensions for the code languages the panel's downloads name. Other languages get `.txt`. */
const languageExtensions: Record<string, string> = {
  bash: "sh",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  css: "css",
  go: "go",
  java: "java",
  javascript: "js",
  json: "json",
  kotlin: "kt",
  php: "php",
  python: "py",
  ruby: "rb",
  rust: "rs",
  sql: "sql",
  swift: "swift",
  typescript: "ts",
  tsx: "tsx",
  jsx: "jsx",
  yaml: "yaml",
};

/** The file extension a version downloads with, from its kind or, for code, its language. */
export function extensionOf(kind: ArtifactKind, language: string | null): string {
  if (kind === "markdown") return "md";
  if (kind === "mermaid") return "mmd";
  if (kind !== "code") return kind;
  return (language && languageExtensions[language.toLowerCase()]) || "txt";
}

/**
 * The download file name: the title with characters a file name can't hold removed, then the
 * extension for the kind or language.
 */
export function artifactFileName({
  title,
  kind,
  language,
}: {
  title: string;
  kind: ArtifactKind;
  language: string | null;
}): string {
  const safe = [...title].map((char) => (char.charCodeAt(0) < 32 ? " " : char)).join("");
  const base = safe.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Artifact";
  return `${base}.${extensionOf(kind, language)}`;
}
