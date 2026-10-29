import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import webPush from "web-push";
import { afterEach, describe, expect, it } from "vitest";

import { webPushProvider } from "../src";

const vapid = webPush.generateVAPIDKeys();
const subject = "mailto:host@example.com";
const notification = {
  title: "Ada Lovelace",
  body: "Your train leaves at 9.",
  url: "https://app.example/bots/0199f1a2-0000-7000-8000-000000000001",
  tag: "0199f1a2-0000-7000-8000-000000000002",
};

/** A device: its P-256 key pair and auth secret, and the subscription the browser would give. */
function device(endpoint: string) {
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  const auth = randomBytes(16);
  return {
    keys,
    auth,
    subscription: {
      endpoint,
      keys: {
        p256dh: keys.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
    },
  };
}

/** Decrypts an `aes128gcm` push body (RFC 8188, RFC 8291) as the device would. */
function decrypt(body: Buffer, { keys, auth }: ReturnType<typeof device>): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverKey = body.subarray(21, 21 + idLength);
  const cipherText = body.subarray(21 + idLength);
  const secret = keys.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), keys.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(cipherText.subarray(-16));
  const padded = Buffer.concat([decipher.update(cipherText.subarray(0, -16)), decipher.final()]);
  // The last record ends with the delimiter 2, then any zero padding.
  const end = padded.lastIndexOf(2);
  return padded.subarray(0, end).toString("utf8");
}

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A local push service that answers `status` and keeps each request it receives. */
async function fakePushService(status = 201) {
  const received: { path: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(status).end(status >= 400 ? "push refused" : "");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, received };
}

describe("the web push provider", () => {
  it("sends a push that decrypts, with the device's keys, to the notification", async () => {
    const service = await fakePushService();
    const phone = device(`${service.origin}/push/phone`);
    const provider = webPushProvider({ ...vapid, subject });

    expect(await provider.send(phone.subscription, notification, { fetch })).toBe("sent");

    const [push] = service.received;
    expect(push!.path).toBe("/push/phone");
    expect(push!.headers["content-encoding"]).toBe("aes128gcm");
    expect(JSON.parse(decrypt(push!.body, phone))).toEqual(notification);
  });

  it("signs the push with the Host's VAPID key for the push service's origin", async () => {
    const service = await fakePushService();
    const provider = webPushProvider({ ...vapid, subject });

    await provider.send(device(`${service.origin}/push/phone`).subscription, notification, {
      fetch,
    });

    const authorization = String(service.received[0]!.headers.authorization);
    expect(authorization).toContain(`k=${vapid.publicKey}`);
    const token = /t=([^,\s]+)/.exec(authorization)![1]!;
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims).toMatchObject({ aud: service.origin, sub: subject });
  });

  it("gives the Host's VAPID public key for a browser to subscribe with", () => {
    expect(webPushProvider({ ...vapid, subject }).publicKey).toBe(vapid.publicKey);
  });

  it.each([403, 404, 410])("reports a %i as a subscription that is gone", async (status) => {
    const service = await fakePushService(status);
    const provider = webPushProvider({ ...vapid, subject });

    expect(
      await provider.send(device(`${service.origin}/push/old`).subscription, notification, {
        fetch,
      }),
    ).toBe("gone");
  });

  it("reports a subscription whose keys can't be encrypted for as gone, sending nothing", async () => {
    const service = await fakePushService();
    const provider = webPushProvider({ ...vapid, subject });
    const broken = {
      endpoint: `${service.origin}/push/broken`,
      keys: { p256dh: "abc", auth: "x" },
    };

    expect(await provider.send(broken, notification, { fetch })).toBe("gone");
    expect(service.received).toEqual([]);
  });

  it("throws on any other refusal, so the push is retried", async () => {
    const service = await fakePushService(429);
    const provider = webPushProvider({ ...vapid, subject });

    await expect(
      provider.send(device(`${service.origin}/push/busy`).subscription, notification, { fetch }),
    ).rejects.toThrow("The push service refused the push (429): push refused");
  });

  it("sends through the fetch it is given", async () => {
    const calls: string[] = [];
    const provider = webPushProvider({ ...vapid, subject });
    const recording = (async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    await provider.send(device("https://push.example/send/phone").subscription, notification, {
      fetch: recording,
    });

    expect(calls).toEqual(["https://push.example/send/phone"]);
  });
});
