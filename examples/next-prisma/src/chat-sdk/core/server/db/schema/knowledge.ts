import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { chatSchema } from "./chat-schema";
import type { KnowledgeFailureCode } from "../../../shared/knowledge/kinds";
import { project } from "./chat";

/** Postgres full-text search vector, generated from a chunk's text. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/** Where a Knowledge file is: being read, searchable, or failed for a reason the row records. */
export const knowledgeFileStatus = chatSchema.enum("knowledge_file_status", [
  "processing",
  "ready",
  "failed",
]);

/**
 * A file a user added to a Project's Knowledge (ADR 0014). It belongs to the Project, not to a
 * Message. The original bytes live in the blob store under `knowledge/<id>`, so Retry needs no
 * re-upload. Its passages are `knowledge_chunk` rows.
 */
export const knowledgeFile = chatSchema.table(
  "knowledge_file",
  {
    /** uuidv7, generated in app code. */
    id: uuid("id").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `chat` schema. */
    userId: text("user_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `text/markdown` or `text/plain`. */
    mediaType: text("media_type").notNull(),
    /** Size in bytes. */
    size: integer("size").notNull(),
    status: knowledgeFileStatus("status").notNull().default("processing"),
    /** Why the file failed, a code the UI shows as a reason; null unless `status` is `failed`. */
    failureCode: text("failure_code").$type<KnowledgeFailureCode>(),
    /** The passage count once ready; null before. */
    chunkCount: integer("chunk_count"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("knowledge_file_project_id_idx").on(table.projectId)],
);

/**
 * One passage of a Knowledge file, with its embedding. Searched by meaning (the HNSW index on
 * `embedding`, cosine) and by keywords (the generated `tsv`, English). Goes with its file.
 */
export const knowledgeChunk = chatSchema.table(
  "knowledge_chunk",
  {
    fileId: uuid("file_id")
      .notNull()
      .references(() => knowledgeFile.id, { onDelete: "cascade" }),
    /** The passage's place in its file, from 0. */
    position: integer("position").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    tsv: tsvector("tsv")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english', "text")`),
  },
  (table) => [
    primaryKey({ columns: [table.fileId, table.position] }),
    index("knowledge_chunk_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("knowledge_chunk_tsv_idx").using("gin", table.tsv),
  ],
);

export type KnowledgeFileRow = typeof knowledgeFile.$inferSelect;
