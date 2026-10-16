import { chat } from "@/lib/chat";

/** The Bot SDK's one handler: RPC calls, the Run POST and join GET, and the Shared link read. */
const handle = (request: Request) => chat.handler(request);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
