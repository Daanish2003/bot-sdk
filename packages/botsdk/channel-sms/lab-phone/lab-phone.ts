import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The DER prefix of an Ed25519 private key (PKCS8), before its 32-byte seed. */
const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");

export type Text = {
  id: string;
  /** `out` is a text the app sent, `in` one typed on the page. */
  direction: "in" | "out";
  from: string;
  to: string;
  text: string;
  at: string;
};

export type LabPhone = {
  /** The origin to give the adapter as `apiBase`. */
  url: string;
  /** The webhook public key (base64 of 32 raw bytes) to give the account as `publicKey`. */
  publicKey: string;
  texts: Text[];
  close(): Promise<void>;
};

function keysOf(seed: string) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, createHash("sha256").update(seed).digest()]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  return { privateKey, publicKey };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * A local stand-in for Telnyx (spec #1174), the way Mailpit stands in for email. It answers the
 * parts of Telnyx's v2 API the adapter uses (`GET /v2/phone_numbers`, `POST /v2/messages`) and
 * serves a page that shows the texts the app sent, per phone number, and sends a text "from" any
 * number to the app's webhook as a `message.received` event signed with its own Ed25519 key. The
 * key comes from `seed`, so it is the same after a restart. For a machine of your own only: it
 * accepts any API key and keeps its texts in memory.
 */
export async function startLabPhone({
  port = 0,
  host = "127.0.0.1",
  seed = "lab-phone",
  webhookUrl = "",
}: {
  port?: number;
  host?: string;
  /** What the signing key is made from. */
  seed?: string;
  /** The app's webhook route for the account, `.../channels/sms/<accountId>`; the page can change it. */
  webhookUrl?: string;
} = {}): Promise<LabPhone> {
  const { privateKey, publicKey } = keysOf(seed);
  const texts: Text[] = [];
  let target = webhookUrl;

  /** Posts a signed `message.received` event to the webhook; returns a note for the page. */
  async function receive(from: string, to: string, text: string): Promise<string> {
    if (!target) return "Set the webhook URL first.";
    const id = randomUUID();
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: { id, text, from: { phone_number: from }, to: [{ phone_number: to }] },
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString(
      "base64",
    );
    // Recorded before the call, so an instant reply from the app lands below it.
    texts.push({ id, direction: "in", from, to, text, at: new Date().toISOString() });
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "telnyx-signature-ed25519": signature,
          "telnyx-timestamp": timestamp,
        },
        body,
      });
      return response.ok ? "Sent." : `The app answered ${response.status}.`;
    } catch (error) {
      return `Could not reach the app: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** The number a text belongs to on the page: the phone it came from, or the one it went to. */
  const phoneOf = (t: Text) => (t.direction === "in" ? t.from : t.to);

  function page(note: string) {
    const threads = [...new Set(texts.map(phoneOf))]
      .map((number) => {
        const lines = texts
          .filter((t) => phoneOf(t) === number)
          .map(
            (t) =>
              `<li class="${t.direction}"><b>${t.direction === "in" ? "you" : "app"}</b> <span>${escapeHtml(t.text)}</span></li>`,
          )
          .join("");
        return `<section><h2>${escapeHtml(number)}</h2><ul>${lines}</ul></section>`;
      })
      .join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lab phone</title>
<style>body{font:15px system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}li{list-style:none;margin:.25rem 0}ul{padding:0}.out span{background:#e8eefc;padding:.15rem .5rem;border-radius:.5rem}.in span{background:#e3f6e3;padding:.15rem .5rem;border-radius:.5rem}label{display:block;margin:.5rem 0}input,textarea{width:100%;box-sizing:border-box;font:inherit}code{word-break:break-all}</style></head><body>
<h1>Lab phone</h1>
${note ? `<p role="status">${escapeHtml(note)}</p>` : ""}
<p>Webhook public key: <code id="public-key">${escapeHtml(publicKey)}</code></p>
<form method="post" action="/webhook-url"><label>Webhook URL (the app's <code>/channels/sms/&lt;accountId&gt;</code> route)<input name="url" value="${escapeHtml(target)}"></label><button>Save</button></form>
<h2>Text the app</h2>
<form method="post" action="/receive"><label>From (your number)<input name="from" value="+15550002222" required></label><label>To (the app's number)<input name="to" value="+15550001111" required></label><label>Text<textarea name="text" required></textarea></label><button>Send</button></form>
<h2>Texts</h2>${threads || "<p>None yet.</p>"}
</body></html>`;
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://lab-phone");
      const method = request.method ?? "GET";
      // A page on another origin can't post a form here: it would make the lab phone call any URL.
      const origin = request.headers.origin;
      if (method === "POST" && origin && new URL(origin).host !== request.headers.host) {
        return json(response, 403, { errors: [{ title: "Cross-origin post refused" }] });
      }

      if (method === "GET" && url.pathname === "/v2/phone_numbers") {
        const number = url.searchParams.get("filter[phone_number]");
        return json(response, 200, { data: number ? [{ phone_number: number }] : [] });
      }
      if (method === "POST" && url.pathname === "/v2/messages") {
        const sent = JSON.parse((await readBody(request)) || "{}") as {
          from?: string;
          to?: string;
          text?: string;
        };
        if (!sent.from || !sent.to || !sent.text?.trim()) {
          return json(response, 422, {
            errors: [{ title: "Invalid", detail: "from, to and text are required" }],
          });
        }
        const id = randomUUID();
        texts.push({
          id,
          direction: "out",
          from: sent.from,
          to: sent.to,
          text: sent.text,
          at: new Date().toISOString(),
        });
        return json(response, 200, { data: { id, record_type: "message", type: "SMS" } });
      }
      if (method === "GET" && url.pathname === "/texts") return json(response, 200, texts);
      if (method === "GET" && url.pathname === "/") {
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(page(url.searchParams.get("note") ?? ""));
        return;
      }
      if (method === "POST" && url.pathname === "/webhook-url") {
        target = new URLSearchParams(await readBody(request)).get("url")?.trim() ?? "";
        response.writeHead(303, { location: "/" }).end();
        return;
      }
      if (method === "POST" && url.pathname === "/receive") {
        const form = new URLSearchParams(await readBody(request));
        const note = await receive(
          form.get("from") ?? "",
          form.get("to") ?? "",
          form.get("text") ?? "",
        );
        response.writeHead(303, { location: `/?note=${encodeURIComponent(note)}` }).end();
        return;
      }
      json(response, 404, { errors: [{ title: "Not found" }] });
    })().catch((error) => json(response, 500, { errors: [{ title: String(error) }] }));
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${address.port}`,
    publicKey,
    texts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
