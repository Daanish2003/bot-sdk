import { chat } from "@/lib/chat";

/**
 * The Bot SDK's inbound webhook for webhook Routines (ADR 0021). No sign-in: the token in the URL is
 * the authentication, and the handler answers 202, 404 or 413.
 */
export const POST = (request: Request) => chat.plugin("bot").webhookHandler(request);
