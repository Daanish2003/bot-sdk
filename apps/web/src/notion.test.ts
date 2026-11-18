import { ConnectionBrokenError, type HostTool } from "@botsdk/mcp";
import { describe, expect, it } from "vitest";

import { notionTools } from "./notion";

const api = "https://api.notion.com/v1";
const token = "ntn_notion-token";

type Sent = {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
  version: string | null;
};

/** A fake Notion HTTP API: records each request and answers it with `answer`. */
function fakeNotion(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const one: Sent = {
      method: request.method,
      url: request.url,
      body: text ? JSON.parse(text) : undefined,
      authorization: request.headers.get("authorization"),
      version: request.headers.get("notion-version"),
    };
    sent.push(one);
    return answer(one);
  }) as typeof globalThis.fetch;
  const tools = Object.fromEntries(notionTools(fetch).map((tool) => [tool.name, tool]));
  return { sent, tools };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const text = (content: string) => ({ plain_text: content, text: { content } });

/** Runs `tool` with `input` and the Connection's token, its input and result checked by its schemas. */
async function run(tool: HostTool | undefined, input: unknown) {
  if (!tool) throw new Error("No such tool");
  const parsedInput = await parse(tool.inputSchema, input);
  const result = await tool.execute(parsedInput, { accessToken: token });
  return parse(tool.outputSchema, result);
}

async function parse(schema: unknown, value: unknown) {
  const standard = (schema as { "~standard": { validate: (value: unknown) => unknown } })[
    "~standard"
  ];
  const result = (await standard.validate(value)) as { value?: unknown; issues?: unknown[] };
  if (result.issues) throw new Error(`Schema issues: ${JSON.stringify(result.issues)}`);
  return result.value;
}

const notionPage = {
  object: "page",
  id: "p1",
  url: "https://www.notion.so/Roadmap-p1",
  last_edited_time: "2026-11-17T10:00:00.000Z",
  parent: { type: "data_source_id", data_source_id: "ds1" },
  properties: {
    Name: { type: "title", title: [text("Roadmap")] },
    Status: { type: "status", status: { name: "Doing" } },
    Tags: { type: "multi_select", multi_select: [{ name: "q4" }, { name: "web" }] },
    Estimate: { type: "number", number: 3 },
    Done: { type: "checkbox", checkbox: false },
    Due: { type: "date", date: { start: "2026-12-01", end: null } },
    Owner: { type: "people", people: [{ id: "u1", name: "Nora" }] },
    Empty: { type: "rich_text", rich_text: [] },
  },
};

describe("the Notion tools", () => {
  it("are the six Notion tools", () => {
    expect(notionTools().map((tool) => tool.name)).toEqual([
      "search",
      "get_page",
      "query_database",
      "create_page",
      "append_to_page",
      "add_comment",
    ]);
  });

  it("each publishes input and output schemas", () => {
    for (const tool of notionTools()) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.description, tool.name).toBeTruthy();
    }
  });

  it("search searches by title, with the Notion version and the Connection's token", async () => {
    const { sent, tools } = fakeNotion(() =>
      json({
        results: [
          notionPage,
          {
            object: "data_source",
            id: "ds1",
            url: "https://www.notion.so/ds1",
            title: [text("Projects")],
            parent: { type: "database_id", database_id: "db1" },
          },
        ],
        has_more: true,
        next_cursor: "c2",
      }),
    );

    const result = await run(tools.search, { query: "road", pageSize: 5 });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: `${api}/search`,
      authorization: `Bearer ${token}`,
      version: "2026-03-11",
      body: { query: "road", page_size: 5 },
    });
    expect(result).toEqual({
      results: [
        {
          id: "p1",
          type: "page",
          title: "Roadmap",
          url: "https://www.notion.so/Roadmap-p1",
          lastEditedTime: "2026-11-17T10:00:00.000Z",
        },
        {
          id: "ds1",
          type: "data_source",
          title: "Projects",
          url: "https://www.notion.so/ds1",
          databaseId: "db1",
        },
      ],
      nextCursor: "c2",
    });
  });

  it("search can ask for pages or data sources only, from a cursor", async () => {
    const { sent, tools } = fakeNotion(() => json({ results: [], has_more: false }));

    const result = await run(tools.search, { type: "data_source", cursor: "c2" });

    expect(sent[0]?.body).toEqual({
      page_size: 20,
      filter: { property: "object", value: "data_source" },
      start_cursor: "c2",
    });
    expect(result).toEqual({ results: [] });
  });

  it("get_page answers the page's properties and its blocks as plain text", async () => {
    const { sent, tools } = fakeNotion((request) => {
      if (request.url === `${api}/pages/p1`) return json(notionPage);
      if (request.url === `${api}/blocks/p1/children?page_size=100`) {
        return json({
          results: [
            { type: "heading_1", heading_1: { rich_text: [text("Goals")] } },
            { type: "paragraph", paragraph: { rich_text: [text("Ship "), text("it.")] } },
            { type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("one")] } },
            { type: "to_do", to_do: { rich_text: [text("two")], checked: true } },
            { type: "image", image: {} },
            { type: "divider", divider: {} },
          ],
          has_more: true,
          next_cursor: "b2",
        });
      }
      return json(
        {
          results: [{ type: "paragraph", paragraph: { rich_text: [text("Last.")] } }],
          has_more: false,
        },
        200,
      );
    });

    const result = await run(tools.get_page, { pageId: "p1" });

    expect(sent.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: `${api}/pages/p1` },
      { method: "GET", url: `${api}/blocks/p1/children?page_size=100` },
      { method: "GET", url: `${api}/blocks/p1/children?page_size=100&start_cursor=b2` },
    ]);
    expect(result).toEqual({
      id: "p1",
      url: "https://www.notion.so/Roadmap-p1",
      title: "Roadmap",
      properties: {
        Name: "Roadmap",
        Status: "Doing",
        Tags: "q4, web",
        Estimate: "3",
        Done: "false",
        Due: "2026-12-01",
        Owner: "Nora",
        Empty: "",
      },
      content: "# Goals\nShip it.\n- one\n[x] two\n---\nLast.",
    });
  });

  it("query_database queries the database's data source with its filter and sorts", async () => {
    const { sent, tools } = fakeNotion((request) =>
      request.url === `${api}/databases/db1`
        ? json({ data_sources: [{ id: "ds1", name: "Projects" }] })
        : json({ results: [notionPage], has_more: false }),
    );
    const filter = { property: "Status", status: { equals: "Doing" } };
    const sorts = [{ timestamp: "last_edited_time", direction: "descending" }];

    const result = await run(tools.query_database, { databaseId: "db1", filter, sorts });

    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "GET", url: `${api}/databases/db1`, body: undefined },
      {
        method: "POST",
        url: `${api}/data_sources/ds1/query`,
        body: { page_size: 20, filter, sorts },
      },
    ]);
    expect(result).toMatchObject({
      rows: [
        { id: "p1", url: "https://www.notion.so/Roadmap-p1", properties: { Name: "Roadmap" } },
      ],
    });
  });

  it("query_database goes straight to a data source it is given", async () => {
    const { sent, tools } = fakeNotion(() =>
      json({ results: [], has_more: true, next_cursor: "n2" }),
    );

    const result = await run(tools.query_database, { dataSourceId: "ds9", cursor: "n1" });

    expect(sent.map(({ url, body }) => ({ url, body }))).toEqual([
      { url: `${api}/data_sources/ds9/query`, body: { page_size: 20, start_cursor: "n1" } },
    ]);
    expect(result).toEqual({ rows: [], nextCursor: "n2" });
  });

  it("query_database needs a database or a data source", async () => {
    const { tools } = fakeNotion(() => json({}));

    await expect(run(tools.query_database, {})).rejects.toThrow("databaseId or dataSourceId");
  });

  it("create_page under a page sets its title and its content as paragraphs", async () => {
    const { sent, tools } = fakeNotion(() =>
      json({ ...notionPage, id: "p2", url: "https://n/p2" }),
    );

    const result = await run(tools.create_page, {
      parentPageId: "pp1",
      title: "Notes",
      content: "First.\n\nSecond.",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", url: `${api}/pages` });
    expect(sent[0]?.body).toEqual({
      parent: { type: "page_id", page_id: "pp1" },
      properties: { title: { title: [{ text: { content: "Notes" } }] } },
      children: [
        { type: "paragraph", paragraph: { rich_text: [{ text: { content: "First." } }] } },
        { type: "paragraph", paragraph: { rich_text: [{ text: { content: "Second." } }] } },
      ],
    });
    expect(result).toEqual({ id: "p2", url: "https://n/p2" });
  });

  it("create_page in a database finds the title property and takes the other properties as given", async () => {
    const { sent, tools } = fakeNotion((request) => {
      if (request.url === `${api}/databases/db1`) {
        return json({ data_sources: [{ id: "ds1", name: "Projects" }] });
      }
      if (request.url === `${api}/data_sources/ds1`) {
        return json({ properties: { Status: { type: "status" }, Project: { type: "title" } } });
      }
      return json({ ...notionPage, id: "p3", url: "https://n/p3" });
    });

    const result = await run(tools.create_page, {
      databaseId: "db1",
      title: "Launch",
      properties: { Status: { status: { name: "Todo" } } },
    });

    expect(sent.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: `${api}/databases/db1` },
      { method: "GET", url: `${api}/data_sources/ds1` },
      { method: "POST", url: `${api}/pages` },
    ]);
    expect(sent[2]?.body).toEqual({
      parent: { type: "data_source_id", data_source_id: "ds1" },
      properties: {
        Status: { status: { name: "Todo" } },
        Project: { title: [{ text: { content: "Launch" } }] },
      },
    });
    expect(result).toEqual({ id: "p3", url: "https://n/p3" });
  });

  it("create_page needs exactly one parent", async () => {
    const { sent, tools } = fakeNotion(() => json({}));

    await expect(run(tools.create_page, { title: "x" })).rejects.toThrow("exactly one");
    await expect(
      run(tools.create_page, { title: "x", parentPageId: "a", databaseId: "b" }),
    ).rejects.toThrow("exactly one");
    expect(sent).toEqual([]);
  });

  it("append_to_page adds paragraphs at the end, and splits a long one under Notion's text limit", async () => {
    const { sent, tools } = fakeNotion(() => json({ results: [{}, {}, {}] }));

    const result = await run(tools.append_to_page, {
      pageId: "p1",
      content: `${"a".repeat(2000)}${"b".repeat(5)}`,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "PATCH", url: `${api}/blocks/p1/children` });
    const { children } = sent[0]!.body as {
      children: { paragraph: { rich_text: { text: { content: string } }[] } }[];
    };
    expect(children).toHaveLength(1);
    expect(children[0]?.paragraph.rich_text.map((part) => part.text.content)).toEqual([
      "a".repeat(2000),
      "b".repeat(5),
    ]);
    expect(result).toEqual({ pageId: "p1", blocksAdded: 3 });
  });

  it("add_comment comments on a page", async () => {
    const { sent, tools } = fakeNotion(() => json({ id: "c1", discussion_id: "d1" }));

    const result = await run(tools.add_comment, { pageId: "p1", text: "Looks good." });

    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: "POST",
        url: `${api}/comments`,
        body: { parent: { page_id: "p1" }, rich_text: [{ text: { content: "Looks good." } }] },
      },
    ]);
    expect(result).toEqual({ commentId: "c1", discussionId: "d1" });
  });

  it.each([
    ["search", { query: "x" }],
    ["get_page", { pageId: "p1" }],
    ["query_database", { dataSourceId: "ds1" }],
    ["create_page", { parentPageId: "p1", title: "x" }],
    ["append_to_page", { pageId: "p1", content: "x" }],
    ["add_comment", { pageId: "p1", text: "x" }],
  ])("%s reports a broken Connection when Notion answers HTTP 401", async (name, input) => {
    const { tools } = fakeNotion(() =>
      json(
        { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." },
        401,
      ),
    );

    await expect(run(tools[name], input)).rejects.toBeInstanceOf(ConnectionBrokenError);
  });

  it("answers any other Notion failure with Notion's own message", async () => {
    const { tools } = fakeNotion(() =>
      json(
        { object: "error", status: 404, code: "object_not_found", message: "Could not find page." },
        404,
      ),
    );

    const error = await run(tools.get_page, { pageId: "nope" }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConnectionBrokenError);
    expect((error as Error).message).toBe("Notion answered HTTP 404: Could not find page.");
  });
});
