import { ConnectionBrokenError, type HostTool } from "@botsdk/mcp";
import { describe, expect, it } from "vitest";

import { googleCalendarTools } from "./google-calendar";

const api = "https://www.googleapis.com/calendar/v3";
const token = "ya29.calendar-token";

type Sent = { method: string; url: string; body: unknown; authorization: string | null };

/** A fake Google HTTP API: records each request and answers it with `answer`. */
function fakeGoogle(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const one: Sent = {
      method: request.method,
      url: request.url,
      body: text ? JSON.parse(text) : undefined,
      authorization: request.headers.get("authorization"),
    };
    sent.push(one);
    return answer(one);
  }) as typeof globalThis.fetch;
  const tools = Object.fromEntries(googleCalendarTools(fetch).map((tool) => [tool.name, tool]));
  return { sent, tools };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const googleEvent = {
  id: "ev1",
  status: "confirmed",
  htmlLink: "https://calendar.google.com/event?eid=ev1",
  summary: "Stand-up",
  location: "Room 4",
  start: { dateTime: "2026-11-18T09:00:00Z" },
  end: { dateTime: "2026-11-18T09:15:00Z" },
  organizer: { email: "boss@example.com" },
  attendees: [
    { email: "boss@example.com", responseStatus: "accepted", organizer: true },
    { email: "me@example.com", responseStatus: "needsAction", self: true },
  ],
  etag: '"3"',
  kind: "calendar#event",
};

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

describe("the Google Calendar tools", () => {
  it("are the five Calendar tools, with no delete", () => {
    expect(googleCalendarTools().map((tool) => tool.name)).toEqual([
      "list_calendars",
      "list_events",
      "create_event",
      "update_event",
      "respond_to_event",
    ]);
  });

  it("list_calendars reads the user's calendar list", async () => {
    const { sent, tools } = fakeGoogle(() =>
      json({
        items: [
          {
            id: "primary-id",
            summary: "Me",
            primary: true,
            accessRole: "owner",
            timeZone: "Europe/London",
          },
          { id: "team-id", summary: "Team", accessRole: "reader", timeZone: "Europe/Paris" },
        ],
      }),
    );

    const result = await run(tools.list_calendars, {});

    expect(sent).toEqual([
      {
        method: "GET",
        url: `${api}/users/me/calendarList`,
        body: undefined,
        authorization: `Bearer ${token}`,
      },
    ]);
    expect(result).toEqual({
      calendars: [
        {
          id: "primary-id",
          name: "Me",
          primary: true,
          accessRole: "owner",
          timeZone: "Europe/London",
        },
        {
          id: "team-id",
          name: "Team",
          primary: false,
          accessRole: "reader",
          timeZone: "Europe/Paris",
        },
      ],
    });
  });

  it("list_events reads a time range of single events, in start order", async () => {
    const { sent, tools } = fakeGoogle(() => json({ items: [googleEvent] }));

    const result = await run(tools.list_events, {
      timeMin: "2026-11-18T00:00:00Z",
      timeMax: "2026-11-19T00:00:00Z",
      query: "stand",
    });

    const url = new URL(sent[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${api}/calendars/primary/events`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      timeMin: "2026-11-18T00:00:00Z",
      timeMax: "2026-11-19T00:00:00Z",
      q: "stand",
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
    expect(result).toEqual({
      events: [
        {
          id: "ev1",
          status: "confirmed",
          link: "https://calendar.google.com/event?eid=ev1",
          title: "Stand-up",
          location: "Room 4",
          start: { dateTime: "2026-11-18T09:00:00Z" },
          end: { dateTime: "2026-11-18T09:15:00Z" },
          organizer: "boss@example.com",
          attendees: [
            { email: "boss@example.com", response: "accepted" },
            { email: "me@example.com", response: "needsAction", self: true },
          ],
          myResponse: "needsAction",
        },
      ],
    });
  });

  it("list_events reads another calendar by its id", async () => {
    const { sent, tools } = fakeGoogle(() => json({ items: [] }));

    await run(tools.list_events, {
      calendarId: "team@group.calendar.google.com",
      timeMin: "2026-11-18T00:00:00Z",
      timeMax: "2026-11-19T00:00:00Z",
    });

    expect(new URL(sent[0]!.url).pathname).toBe(
      "/calendar/v3/calendars/team%40group.calendar.google.com/events",
    );
  });

  it("create_event posts the event, inviting its guests, and answers it", async () => {
    const { sent, tools } = fakeGoogle(() => json(googleEvent));

    const result = await run(tools.create_event, {
      title: "Stand-up",
      start: { dateTime: "2026-11-18T09:00:00Z" },
      end: { dateTime: "2026-11-18T09:15:00Z" },
      location: "Room 4",
      attendees: ["boss@example.com"],
    });

    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: "POST",
        url: `${api}/calendars/primary/events?sendUpdates=all`,
        body: {
          summary: "Stand-up",
          start: { dateTime: "2026-11-18T09:00:00Z" },
          end: { dateTime: "2026-11-18T09:15:00Z" },
          location: "Room 4",
          attendees: [{ email: "boss@example.com" }],
        },
      },
    ]);
    expect(result).toMatchObject({ event: { id: "ev1", title: "Stand-up" } });
  });

  it("update_event patches only the fields given, and tells the guests", async () => {
    const { sent, tools } = fakeGoogle(() => json({ ...googleEvent, summary: "Retro" }));

    const result = await run(tools.update_event, { eventId: "ev1", title: "Retro" });

    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: "PATCH",
        url: `${api}/calendars/primary/events/ev1?sendUpdates=all`,
        body: { summary: "Retro" },
      },
    ]);
    expect(result).toMatchObject({ event: { id: "ev1", title: "Retro" } });
  });

  it("update_event replaces a time whole, so an all-day event can become a timed one", async () => {
    const { sent, tools } = fakeGoogle(() => json(googleEvent));

    await run(tools.update_event, {
      eventId: "ev1",
      start: { dateTime: "2026-11-18T09:00:00Z" },
      end: { date: "2026-11-19" },
    });

    expect(sent[0]?.body).toEqual({
      start: { dateTime: "2026-11-18T09:00:00Z", date: null, timeZone: null },
      end: { dateTime: null, date: "2026-11-19", timeZone: null },
    });
  });

  it("respond_to_event sets only the user's own answer, leaving the guest list to Google", async () => {
    const { sent, tools } = fakeGoogle((request) =>
      request.method === "GET"
        ? json(googleEvent)
        : json({
            ...googleEvent,
            attendees: [
              googleEvent.attendees[0],
              { ...googleEvent.attendees[1], responseStatus: "tentative" },
            ],
          }),
    );

    const result = await run(tools.respond_to_event, { eventId: "ev1", response: "tentative" });

    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "GET", url: `${api}/calendars/primary/events/ev1`, body: undefined },
      {
        method: "PATCH",
        url: `${api}/calendars/primary/events/ev1?sendUpdates=all`,
        body: {
          attendeesOmitted: true,
          attendees: [{ email: "me@example.com", responseStatus: "tentative" }],
        },
      },
    ]);
    expect(result).toMatchObject({ event: { id: "ev1", myResponse: "tentative" } });
  });

  it("respond_to_event refuses an event the user isn't invited to", async () => {
    const { sent, tools } = fakeGoogle(() => json({ ...googleEvent, attendees: [] }));

    await expect(
      run(tools.respond_to_event, { eventId: "ev1", response: "accepted" }),
    ).rejects.toThrow(/not a guest/);
    expect(sent.map((each) => each.method)).toEqual(["GET"]);
  });

  it.each([
    ["HTTP 401", () => new Response("Unauthorized", { status: 401 })],
    [
      // What Google answers a token whose grant the user revoked.
      "a revoked grant",
      () =>
        json(
          {
            error: {
              code: 401,
              message: "Request had invalid authentication credentials.",
              status: "UNAUTHENTICATED",
            },
          },
          401,
        ),
    ],
    [
      // A link the user unticked a Calendar scope on: linking again asks for it.
      "a token without the Calendar scopes",
      () =>
        json(
          {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
              details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
            },
          },
          403,
        ),
    ],
  ])("reports %s as a broken Connection", async (_case, answer) => {
    const { tools } = fakeGoogle(answer);

    await expect(run(tools.list_calendars, {})).rejects.toBeInstanceOf(ConnectionBrokenError);
  });

  it("answers any other error with Google's message", async () => {
    const { tools } = fakeGoogle(() =>
      json({ error: { code: 404, message: "Not Found", status: "NOT_FOUND" } }, 404),
    );

    const failure = run(tools.update_event, { eventId: "gone", title: "Retro" });

    await expect(failure).rejects.toThrow("Google Calendar answered HTTP 404: Not Found");
    await expect(failure).rejects.not.toBeInstanceOf(ConnectionBrokenError);
  });

  it("answers a write to a calendar the user can only read as the call's error, not a broken Connection", async () => {
    const { tools } = fakeGoogle(() =>
      json(
        {
          error: {
            code: 403,
            message: "You need to have writer access to this calendar.",
            status: "PERMISSION_DENIED",
            errors: [{ reason: "requiredAccessLevel" }],
          },
        },
        403,
      ),
    );

    const failure = run(tools.update_event, { eventId: "ev1", title: "Retro" });

    await expect(failure).rejects.toThrow("You need to have writer access to this calendar.");
    await expect(failure).rejects.not.toBeInstanceOf(ConnectionBrokenError);
  });
});
