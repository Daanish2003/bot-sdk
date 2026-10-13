import type { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import type { ChatClient } from "../../../core/client/chat-client";
import { KnowledgeTab } from "../../../ui/pages/project-knowledge";
import { renderWrapped, untranslated } from "../fake-dictionary";

const projectId = "00000000-0000-4000-8000-000000000001";
const openai = "openai:text-embedding-3-small";

type KnowledgeFile = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  status: "processing" | "ready" | "failed";
  failureCode: "no_text" | "no_credentials" | null;
  chunkCount: number | null;
  createdAt: Date;
};

type KnowledgeData = {
  embeddingModel: string | null;
  currentModel: { id: string; onHostCredentials: boolean } | null;
  models: string[];
  files: KnowledgeFile[];
};

/**
 * Strings the dictionary doesn't own: the user's file names, Model names from core/client/models,
 * and the locale's size and date formats (with the separators the table puts around them).
 */
const owned = [
  "notes.md",
  "ready.md",
  "wait.txt",
  "lost.md",
  "text-embedding-3-small",
  "· 1.5 kB ·",
  "· 1.5 kB · —",
];

const file = (overrides: Partial<KnowledgeFile>): KnowledgeFile => ({
  id: "f1",
  name: "notes.md",
  mediaType: "text/markdown",
  size: 1536,
  status: "ready" as const,
  failureCode: null,
  chunkCount: 2,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  ...overrides,
});

function seedKnowledge(queryClient: QueryClient, client: ChatClient, data: KnowledgeData) {
  queryClient.setQueryData(client.orpc.knowledge.list.queryKey({ input: { projectId } }), data);
}

function render(data: KnowledgeData) {
  return renderWrapped(createElement(KnowledgeTab, { projectId }), {
    seed: (queryClient, client) => seedKnowledge(queryClient, client, data),
  });
}

describe("the Knowledge tab", () => {
  it("shows the empty state with the Model picker, and no untranslated text", () => {
    const html = render({
      embeddingModel: openai,
      currentModel: { id: openai, onHostCredentials: true },
      models: [openai],
      files: [],
    });

    expect(html).toContain("⟦No Knowledge files yet⟧");
    expect(html).toContain('aria-label="⟦Embedding Model⟧"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
    expect(untranslated(html, owned)).toEqual([]);
  });

  it("lists files with their status, passages and failure, and no untranslated text", () => {
    const html = render({
      embeddingModel: openai,
      currentModel: { id: openai, onHostCredentials: true },
      models: [openai],
      files: [
        file({ id: "f1", name: "ready.md", status: "ready", chunkCount: 2 }),
        file({
          id: "f2",
          name: "wait.txt",
          mediaType: "text/plain",
          status: "processing",
          chunkCount: null,
        }),
        file({
          id: "f3",
          name: "lost.md",
          status: "failed",
          failureCode: "no_credentials",
          chunkCount: null,
        }),
      ],
    });

    expect(html).toContain("⟦Ready⟧");
    expect(html).toContain("⟦Processing⟧");
    expect(html).toContain("⟦Failed⟧");
    expect(html).toContain("⟦2 passages⟧");
    expect(html).toContain("⟦No credentials for the Model⟧");
    expect(html).toContain("⟦Text⟧");
    expect(untranslated(html, owned)).toEqual([]);
  });

  it("locks the Model once the Project has a file, naming whose key it uses", () => {
    const html = render({
      embeddingModel: openai,
      currentModel: { id: openai, onHostCredentials: true },
      models: [openai],
      files: [file({})],
    });

    expect(html).toContain("text-embedding-3-small (⟦Host⟧)");
    expect(html).not.toContain('aria-label="⟦Embedding Model⟧"');
    expect(untranslated(html, owned)).toEqual([]);
  });

  it("warns, and keeps the stored Model named, when its key is gone", () => {
    const html = render({
      embeddingModel: openai,
      currentModel: null,
      models: [],
      files: [file({})],
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("⟦Search unavailable: add your OpenAI key⟧");
    expect(untranslated(html, owned)).toEqual([]);
  });

  it("keeps the locked Model named without a picker when its key is gone", () => {
    const html = render({
      embeddingModel: openai,
      currentModel: null,
      models: [],
      files: [file({})],
    });

    expect(html).toContain("text-embedding-3-small");
    expect(html).not.toContain('aria-label="⟦Embedding Model⟧"');
    expect(html).not.toContain("⟦Uploads need an OpenAI or Gemini key. Add a key⟧");
  });

  it("asks for a key when there is no Model to read files with, and disables uploads", () => {
    const html = render({
      embeddingModel: null,
      currentModel: null,
      models: [],
      files: [],
    });

    expect(html).toContain('role="status"');
    expect(html).toContain("⟦Uploads need an OpenAI or Gemini key. Add a key⟧");
    expect(html).toMatch(/<button(?=[^>]*disabled)[^>]*>⟦Upload files⟧/);
    expect(untranslated(html, owned)).toEqual([]);
  });

  it("asks for a key, not a search warning, when the stored Model's key is gone before any upload", () => {
    const html = render({
      embeddingModel: openai,
      currentModel: null,
      models: [],
      files: [],
    });

    expect(html).toContain("⟦Uploads need an OpenAI or Gemini key. Add a key⟧");
    expect(html).not.toContain('role="alert"');
    expect(html).toMatch(/<button(?=[^>]*disabled)[^>]*>⟦Upload files⟧/);
  });
});
