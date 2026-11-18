import { ConnectionBrokenError, type HostTool } from "@botsdk/mcp";
import { z } from "zod";

// The Notion Connection's tools (ADR 0037), over Notion's REST API, as the integration's user.
// Reads need no approval; the writes are Auto-reviewed (`connectionsOf`). Nothing is deleted.
const api = "https://api.notion.com/v1";
// The API version every request names (https://developers.notion.com/reference/versioning). From
// 2025-09-03 a database holds data sources, and its rows are queried through one.
const notionVersion = "2026-03-11";
// Notion refuses a rich text longer than this, and a request with more blocks than this.
const maxText = 2000;
const maxBlocks = 100;
// A page's blocks are read this many requests deep, at most.
const maxBlockRequests = 10;

type NotionRichText = { plain_text?: string }[];
type NotionProperty = Record<string, unknown> & { type: string };
type NotionObject = {
  id: string;
  url?: string;
  last_edited_time?: string;
  object?: string;
  title?: NotionRichText;
  parent?: { database_id?: string };
  properties?: Record<string, NotionProperty>;
};
type NotionList = { results?: NotionObject[]; has_more?: boolean; next_cursor?: string | null };
type NotionBlock = { type: string } & Record<string, unknown>;

/** Calls Notion as the user, answers the JSON body, and throws what the call's answer is. */
async function notionApi(
  fetch: typeof globalThis.fetch,
  accessToken: string,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  const response = await fetch(`${api}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "notion-version": notionVersion,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: init.signal,
  });
  const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
  if (response.ok) return body ?? {};
  // A revoked or invalid token: the user links Notion again (ADR 0037).
  if (response.status === 401)
    throw new ConnectionBrokenError("Notion refused the Connection's token");
  throw new Error(
    `Notion answered HTTP ${response.status}${body?.message ? `: ${body.message}` : ""}`,
  );
}

const plain = (richText: NotionRichText | undefined) =>
  (richText ?? []).map((part) => part.plain_text ?? "").join("");

/** A property's value as text. */
function propertyText(property: NotionProperty): string {
  const value = property[property.type] as unknown;
  switch (property.type) {
    case "title":
    case "rich_text":
      return plain(value as NotionRichText);
    case "select":
    case "status":
      return (value as { name?: string } | null)?.name ?? "";
    case "multi_select":
      return ((value ?? []) as { name: string }[]).map((each) => each.name).join(", ");
    case "people":
      return ((value ?? []) as { id: string; name?: string }[])
        .map((each) => each.name ?? each.id)
        .join(", ");
    case "relation":
      return ((value ?? []) as { id: string }[]).map((each) => each.id).join(", ");
    case "date": {
      const date = value as { start: string; end?: string | null } | null;
      return date ? (date.end ? `${date.start} to ${date.end}` : date.start) : "";
    }
    case "files":
      return ((value ?? []) as { name: string }[]).map((each) => each.name).join(", ");
    case "formula":
    case "rollup":
      return value && typeof value === "object" && "type" in value
        ? propertyText(value as NotionProperty)
        : "";
    case "unique_id": {
      const id = value as { prefix?: string | null; number?: number } | null;
      return id?.number === undefined ? "" : `${id.prefix ? `${id.prefix}-` : ""}${id.number}`;
    }
    default:
      // number, checkbox, url, email, phone_number, string, boolean, created_time, ...
      return value === null || value === undefined || typeof value === "object"
        ? ""
        : String(value);
  }
}

const propertiesText = (properties: NotionObject["properties"]) =>
  Object.fromEntries(
    Object.entries(properties ?? {}).map(([name, property]) => [name, propertyText(property)]),
  );

const titleOf = (object: NotionObject) =>
  object.title
    ? plain(object.title)
    : plain(
        Object.values(object.properties ?? {}).find((property) => property.type === "title")
          ?.title as NotionRichText,
      );

const blockPrefixes: Record<string, string> = {
  heading_1: "# ",
  heading_2: "## ",
  heading_3: "### ",
  bulleted_list_item: "- ",
  numbered_list_item: "1. ",
  quote: "> ",
};

/** A block as a line of text, or nothing for a block without any. */
function blockText(block: NotionBlock): string | undefined {
  const content = block[block.type] as
    | { rich_text?: NotionRichText; checked?: boolean; title?: string; language?: string }
    | undefined;
  if (block.type === "divider") return "---";
  if (block.type === "child_page" || block.type === "child_database") return content?.title;
  if (!content?.rich_text) return undefined;
  const text = plain(content.rich_text);
  if (block.type === "to_do") return `${content.checked ? "[x]" : "[ ]"} ${text}`;
  return `${blockPrefixes[block.type] ?? ""}${text}`;
}

const richText = (content: string) =>
  Array.from({ length: Math.ceil(content.length / maxText) || 1 }, (_, index) => ({
    text: { content: content.slice(index * maxText, (index + 1) * maxText) },
  }));

/** Blocks for a text, a paragraph for each run of lines between blank lines. */
function paragraphs(content: string) {
  const blocks = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({ type: "paragraph", paragraph: { rich_text: richText(paragraph) } }));
  if (blocks.length > maxBlocks) {
    throw new Error(`The text is more than ${maxBlocks} paragraphs: add it in several calls.`);
  }
  return blocks;
}

const pageId = z.string().meta({ description: "A page's id, from search or query_database." });
const content = z
  .string()
  .meta({ description: "Plain text. A blank line starts a new paragraph." });
const pageSize = z.number().int().min(1).max(100).default(20);
const cursor = z
  .string()
  .optional()
  .meta({ description: "`nextCursor` of the previous answer, for the next results." });

const row = z.object({
  id: z.string(),
  url: z.string().optional(),
  properties: z.record(z.string(), z.string()),
});

/** The six Notion tools, calling Notion through `fetch`. */
export function notionTools(fetch: typeof globalThis.fetch = globalThis.fetch): HostTool[] {
  const call = (
    accessToken: string,
    path: string,
    init?: { method?: string; body?: unknown; signal?: AbortSignal },
  ) => notionApi(fetch, accessToken, path, init);

  /** A database's data source: the one asked for, else the database's first. */
  async function dataSourceOf(
    accessToken: string,
    ids: { databaseId?: string; dataSourceId?: string },
    signal?: AbortSignal,
  ) {
    if (ids.dataSourceId) return ids.dataSourceId;
    const database = (await call(
      accessToken,
      `/databases/${encodeURIComponent(ids.databaseId ?? "")}`,
      {
        signal,
      },
    )) as { data_sources?: { id: string }[] };
    const first = database.data_sources?.[0];
    if (!first) throw new Error("The database has no data source the integration can read.");
    return first.id;
  }

  return [
    {
      name: "search",
      description:
        "Search the pages and data sources the user shared with the integration, by title " +
        "(leave `query` out to list them), most relevant first. A data source is a database's " +
        "table: pass its `databaseId` to query_database.",
      inputSchema: z.object({
        query: z.string().optional().meta({ description: "Words of the title." }),
        type: z.enum(["page", "data_source"]).optional(),
        pageSize,
        cursor,
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            id: z.string(),
            type: z.enum(["page", "data_source"]),
            title: z.string(),
            url: z.string().optional(),
            lastEditedTime: z.string().optional(),
            databaseId: z.string().optional(),
          }),
        ),
        nextCursor: z.string().optional(),
      }),
      execute: async (input, { accessToken, signal }) => {
        const list = (await call(accessToken, "/search", {
          method: "POST",
          body: {
            ...(input.query ? { query: input.query } : {}),
            page_size: input.pageSize,
            ...(input.type ? { filter: { property: "object", value: input.type } } : {}),
            ...(input.cursor ? { start_cursor: input.cursor } : {}),
          },
          signal,
        })) as NotionList;
        return {
          results: (list.results ?? []).map((found) => ({
            id: found.id,
            type: found.object === "data_source" ? ("data_source" as const) : ("page" as const),
            title: titleOf(found),
            url: found.url,
            lastEditedTime: found.last_edited_time,
            databaseId: found.parent?.database_id,
          })),
          ...(list.has_more && list.next_cursor ? { nextCursor: list.next_cursor } : {}),
        };
      },
    },
    {
      name: "get_page",
      description:
        "Read a page: its properties and its content as plain text (its first-level blocks; " +
        "a nested block is not read, and an image or file is left out).",
      inputSchema: z.object({ pageId }),
      outputSchema: z.object({
        id: z.string(),
        url: z.string().optional(),
        title: z.string(),
        properties: z.record(z.string(), z.string()),
        content: z.string(),
        truncated: z
          .boolean()
          .optional()
          .meta({ description: "True when the page is longer than what `content` holds." }),
      }),
      execute: async (input, { accessToken, signal }) => {
        const id = encodeURIComponent(input.pageId);
        const page = (await call(accessToken, `/pages/${id}`, { signal })) as NotionObject;
        const lines: string[] = [];
        let next: string | undefined;
        let truncated = false;
        for (let request = 0; request < maxBlockRequests; request++) {
          const blocks = (await call(
            accessToken,
            `/blocks/${id}/children?page_size=100${next ? `&start_cursor=${encodeURIComponent(next)}` : ""}`,
            { signal },
          )) as { results?: NotionBlock[]; has_more?: boolean; next_cursor?: string | null };
          for (const block of blocks.results ?? []) {
            const line = blockText(block);
            if (line !== undefined) lines.push(line);
          }
          if (!blocks.has_more || !blocks.next_cursor) break;
          next = blocks.next_cursor;
          truncated = request === maxBlockRequests - 1;
        }
        return {
          id: page.id,
          url: page.url,
          title: titleOf(page),
          properties: propertiesText(page.properties),
          content: lines.join("\n"),
          ...(truncated ? { truncated } : {}),
        };
      },
    },
    {
      name: "query_database",
      description:
        "List the rows (pages) of a database, with Notion's filter and sorts. Give the " +
        "`databaseId` (its first data source is queried) or a `dataSourceId` from search.",
      inputSchema: z.object({
        databaseId: z.string().optional(),
        dataSourceId: z.string().optional(),
        filter: z.record(z.string(), z.unknown()).optional().meta({
          description:
            'Notion\'s filter object, such as {"property":"Status","status":{"equals":"Done"}}.',
        }),
        sorts: z.array(z.record(z.string(), z.unknown())).optional().meta({
          description:
            'Notion\'s sorts, such as [{"timestamp":"last_edited_time","direction":"descending"}].',
        }),
        pageSize,
        cursor,
      }),
      outputSchema: z.object({ rows: z.array(row), nextCursor: z.string().optional() }),
      execute: async (input, { accessToken, signal }) => {
        if (!input.databaseId && !input.dataSourceId) {
          throw new Error("Give a databaseId or dataSourceId.");
        }
        const dataSourceId = await dataSourceOf(accessToken, input, signal);
        const list = (await call(
          accessToken,
          `/data_sources/${encodeURIComponent(dataSourceId)}/query`,
          {
            method: "POST",
            body: {
              page_size: input.pageSize,
              ...(input.filter ? { filter: input.filter } : {}),
              ...(input.sorts ? { sorts: input.sorts } : {}),
              ...(input.cursor ? { start_cursor: input.cursor } : {}),
            },
            signal,
          },
        )) as NotionList;
        return {
          rows: (list.results ?? []).map((found) => ({
            id: found.id,
            url: found.url,
            properties: propertiesText(found.properties),
          })),
          ...(list.has_more && list.next_cursor ? { nextCursor: list.next_cursor } : {}),
        };
      },
    },
    {
      name: "create_page",
      description:
        "Create a page with a title and text under a page (`parentPageId`) or as a row of a " +
        "database (`databaseId`, or a `dataSourceId` from search). Give exactly one parent. " +
        "For a row, `properties` sets its other properties in Notion's format, keyed by name.",
      inputSchema: z.object({
        parentPageId: z.string().optional(),
        databaseId: z.string().optional(),
        dataSourceId: z.string().optional(),
        title: z.string(),
        content: content.optional(),
        properties: z.record(z.string(), z.unknown()).optional().meta({
          description: 'A row\'s other properties, such as {"Status":{"status":{"name":"Todo"}}}.',
        }),
      }),
      outputSchema: z.object({ id: z.string(), url: z.string().optional() }),
      execute: async (input, { accessToken, signal }) => {
        const parents = [input.parentPageId, input.databaseId, input.dataSourceId].filter(Boolean);
        if (parents.length !== 1) {
          throw new Error("Give exactly one of parentPageId, databaseId and dataSourceId.");
        }
        const children = input.content ? paragraphs(input.content) : [];
        let parent: unknown;
        let properties: Record<string, unknown>;
        if (input.parentPageId) {
          if (input.properties) {
            throw new Error("A page under a page has only a title: leave `properties` out.");
          }
          parent = { type: "page_id", page_id: input.parentPageId };
          properties = { title: { title: richText(input.title) } };
        } else {
          const dataSourceId = await dataSourceOf(accessToken, input, signal);
          const dataSource = (await call(
            accessToken,
            `/data_sources/${encodeURIComponent(dataSourceId)}`,
            { signal },
          )) as NotionObject;
          const titleName = Object.entries(dataSource.properties ?? {}).find(
            ([, property]) => property.type === "title",
          )?.[0];
          if (!titleName) throw new Error("The database has no title property.");
          parent = { type: "data_source_id", data_source_id: dataSourceId };
          properties = { ...input.properties, [titleName]: { title: richText(input.title) } };
        }
        const page = (await call(accessToken, "/pages", {
          method: "POST",
          body: { parent, properties, ...(children.length > 0 ? { children } : {}) },
          signal,
        })) as NotionObject;
        return { id: page.id, url: page.url };
      },
    },
    {
      name: "append_to_page",
      description: "Add text to the end of a page, a paragraph for each blank-line-separated part.",
      inputSchema: z.object({ pageId, content }),
      outputSchema: z.object({ pageId: z.string(), blocksAdded: z.number() }),
      execute: async (input, { accessToken, signal }) => {
        const children = paragraphs(input.content);
        if (children.length === 0) throw new Error("There is no text to add.");
        const added = (await call(
          accessToken,
          `/blocks/${encodeURIComponent(input.pageId)}/children`,
          { method: "PATCH", body: { children }, signal },
        )) as NotionList;
        return { pageId: input.pageId, blocksAdded: added.results?.length ?? 0 };
      },
    },
    {
      name: "add_comment",
      description: "Comment on a page, as the integration.",
      inputSchema: z.object({ pageId, text: z.string() }),
      outputSchema: z.object({ commentId: z.string(), discussionId: z.string().optional() }),
      execute: async (input, { accessToken, signal }) => {
        const comment = (await call(accessToken, "/comments", {
          method: "POST",
          body: { parent: { page_id: input.pageId }, rich_text: richText(input.text) },
          signal,
        })) as { id: string; discussion_id?: string };
        return { commentId: comment.id, discussionId: comment.discussion_id };
      },
    },
  ];
}
