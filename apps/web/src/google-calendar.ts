import type { HostTool } from "@botsdk/mcp";
import { z } from "zod";

import { googleApi } from "./google-api";

// The Google Calendar Connection's tools (ADR 0037), over the Calendar REST API v3. There is no
// delete. Reads need no approval; every write is Auto-reviewed (`connectionsOf`).
const api = "https://www.googleapis.com/calendar/v3";

const calendarId = z
  .string()
  .default("primary")
  .meta({ description: "The calendar's id, from list_calendars. \"primary\" is the user's own." });

const time = z
  .object({
    dateTime: z.string().optional().meta({
      description: "An RFC 3339 time with its offset, such as 2026-11-18T09:00:00+01:00.",
    }),
    date: z.string().optional().meta({ description: "An all-day event's date, YYYY-MM-DD." }),
    timeZone: z
      .string()
      .optional()
      .meta({ description: "An IANA time zone, such as Europe/London." }),
  })
  .meta({ description: "Either dateTime or, for an all-day event, date." });

const response = z.enum(["needsAction", "accepted", "declined", "tentative"]);

const event = z.object({
  id: z.string(),
  status: z.string().optional(),
  link: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: time.optional(),
  end: time.optional(),
  organizer: z.string().optional(),
  attendees: z
    .array(
      z.object({
        email: z.string().optional(),
        response: response.optional(),
        self: z.boolean().optional(),
      }),
    )
    .optional(),
  /** The user's own answer, when they are a guest. */
  myResponse: response.optional(),
});

const editable = {
  title: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: time.optional(),
  end: time.optional(),
  attendees: z
    .array(z.string())
    .optional()
    .meta({ description: "The guests' email addresses. Replaces the guest list on update." }),
};

type GoogleTime = { dateTime?: string; date?: string; timeZone?: string };
type GoogleAttendee = {
  email?: string;
  responseStatus?: z.infer<typeof response>;
  self?: boolean;
};
type GoogleEvent = {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  organizer?: { email?: string };
  attendees?: GoogleAttendee[];
};

/** A Google event as the tools answer it. */
function eventOf(google: GoogleEvent): z.infer<typeof event> {
  const self = google.attendees?.find((attendee) => attendee.self);
  return {
    id: google.id,
    status: google.status,
    link: google.htmlLink,
    title: google.summary,
    description: google.description,
    location: google.location,
    start: google.start && timeOf(google.start),
    end: google.end && timeOf(google.end),
    organizer: google.organizer?.email,
    attendees: google.attendees?.map((attendee) => ({
      email: attendee.email,
      response: attendee.responseStatus,
      ...(attendee.self ? { self: true } : {}),
    })),
    myResponse: self?.responseStatus,
  };
}

const timeOf = ({ dateTime, date, timeZone }: GoogleTime): GoogleTime => ({
  ...(dateTime ? { dateTime } : {}),
  ...(date ? { date } : {}),
  ...(timeZone ? { timeZone } : {}),
});

/**
 * The fields an input sets, in Google's names: only those given, so an update leaves the rest. A
 * PATCH merges a time into the event's, so with `whole` a time's unset parts are sent as `null`:
 * a timed start then replaces an all-day one rather than adding to it.
 */
function googleFieldsOf(
  input: {
    title?: string;
    description?: string;
    location?: string;
    start?: GoogleTime;
    end?: GoogleTime;
    attendees?: string[];
  },
  whole = false,
) {
  const timeOfInput = (given: GoogleTime) =>
    whole
      ? {
          dateTime: given.dateTime ?? null,
          date: given.date ?? null,
          timeZone: given.timeZone ?? null,
        }
      : given;
  return {
    ...(input.title !== undefined ? { summary: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.start ? { start: timeOfInput(input.start) } : {}),
    ...(input.end ? { end: timeOfInput(input.end) } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.attendees ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
  };
}

/**
 * An event's URL, or the calendar's events'. A write tells the guests (`sendUpdates=all`): Google
 * tells no one by default, while the Bot means a guest to get their invitation or answer.
 */
const eventUrl = (calendar: string, eventId?: string, write = false) =>
  `${api}/calendars/${encodeURIComponent(calendar)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}${write ? "?sendUpdates=all" : ""}`;

/** The five Calendar tools, calling Google through `fetch`. */
export function googleCalendarTools(fetch: typeof globalThis.fetch = globalThis.fetch): HostTool[] {
  const call = (
    accessToken: string,
    url: string,
    init?: { method?: string; body?: unknown; signal?: AbortSignal },
  ) => googleApi(fetch, "Google Calendar", accessToken, url, init);

  return [
    {
      name: "list_calendars",
      description: "List the user's calendars, their own and those shared with them.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        calendars: z.array(
          z.object({
            id: z.string(),
            name: z.string().optional(),
            primary: z.boolean(),
            accessRole: z.string().optional(),
            timeZone: z.string().optional(),
          }),
        ),
      }),
      execute: async (_input, { accessToken, signal }) => {
        const list = (await call(accessToken, `${api}/users/me/calendarList`, { signal })) as {
          items?: Array<{
            id: string;
            summary?: string;
            primary?: boolean;
            accessRole?: string;
            timeZone?: string;
          }>;
        };
        return {
          calendars: (list.items ?? []).map((calendar) => ({
            id: calendar.id,
            name: calendar.summary,
            primary: calendar.primary === true,
            accessRole: calendar.accessRole,
            timeZone: calendar.timeZone,
          })),
        };
      },
    },
    {
      name: "list_events",
      description:
        "List the events of one calendar between two times, recurring ones as single events, " +
        "in start order.",
      inputSchema: z.object({
        calendarId,
        timeMin: z.string().meta({ description: "RFC 3339 start of the range, with its offset." }),
        timeMax: z.string().meta({ description: "RFC 3339 end of the range, with its offset." }),
        query: z.string().optional().meta({ description: "Free text the events must match." }),
        maxResults: z.number().int().min(1).max(250).default(50),
      }),
      outputSchema: z.object({ events: z.array(event) }),
      execute: async (input, { accessToken, signal }) => {
        const url = new URL(eventUrl(input.calendarId));
        url.searchParams.set("timeMin", input.timeMin);
        url.searchParams.set("timeMax", input.timeMax);
        if (input.query) url.searchParams.set("q", input.query);
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set("maxResults", String(input.maxResults));
        const list = (await call(accessToken, url.toString(), { signal })) as {
          items?: GoogleEvent[];
        };
        return { events: (list.items ?? []).map(eventOf) };
      },
    },
    {
      name: "create_event",
      description: "Create an event on one of the user's calendars.",
      inputSchema: z.object({
        calendarId,
        ...editable,
        title: z.string(),
        start: time,
        end: time,
      }),
      outputSchema: z.object({ event }),
      execute: async (input, { accessToken, signal }) => ({
        event: eventOf(
          (await call(accessToken, eventUrl(input.calendarId, undefined, true), {
            method: "POST",
            body: googleFieldsOf(input),
            signal,
          })) as GoogleEvent,
        ),
      }),
    },
    {
      name: "update_event",
      description:
        "Change an event: only the fields given change, and a time given replaces the old one whole.",
      inputSchema: z.object({ calendarId, eventId: z.string(), ...editable }),
      outputSchema: z.object({ event }),
      execute: async (input, { accessToken, signal }) => ({
        event: eventOf(
          (await call(accessToken, eventUrl(input.calendarId, input.eventId, true), {
            method: "PATCH",
            body: googleFieldsOf(input, true),
            signal,
          })) as GoogleEvent,
        ),
      }),
    },
    {
      name: "respond_to_event",
      description: "Answer an invitation the user is a guest of: accept, decline or tentative.",
      inputSchema: z.object({
        calendarId,
        eventId: z.string(),
        response: z.enum(["accepted", "declined", "tentative"]),
      }),
      outputSchema: z.object({ event }),
      execute: async (input, { accessToken, signal }) => {
        const current = (await call(accessToken, eventUrl(input.calendarId, input.eventId), {
          signal,
        })) as GoogleEvent;
        const self = current.attendees?.find((attendee) => attendee.self);
        if (!self?.email) {
          throw new Error("The user is not a guest of this event, so there is nothing to answer.");
        }
        // `attendeesOmitted` sets the user's own answer alone, leaving every other guest as Google
        // has them, even ones its answer to the read left out.
        const updated = (await call(accessToken, eventUrl(input.calendarId, input.eventId, true), {
          method: "PATCH",
          body: {
            attendeesOmitted: true,
            attendees: [{ email: self.email, responseStatus: input.response }],
          },
          signal,
        })) as GoogleEvent;
        return { event: eventOf(updated) };
      },
    },
  ];
}
