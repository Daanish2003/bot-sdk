import net from "node:net";

import type { StreamChunk } from "@tanstack/ai";

import { afterAll, describe, expect, it } from "vitest";

import { createChat } from "../../../../core/server/create-chat";
import {
  createRedisConnection,
  type RedisConnection,
} from "../../../../core/server/chat/redis-connection";
import { createRedisCounters } from "../../../../core/server/chat/redis-counters";
import { createRedisPubSub } from "../../../../core/server/chat/redis-pubsub";
import { createRedisRunStreams } from "../../../../core/server/chat/redis-run-streams";
import { START } from "../../../../core/server/chat/run-streams";
import { redisRuntime } from "../../../../core/server/runtime";
import { counterStoreContract } from "./counters.contract";
import { pubsubContract } from "./pubsub.contract";
import { runStreamsContract } from "./run-streams.contract";

/**
 * The Redis suites need a real Redis: set `TEST_REDIS_URL` (for example
 * `redis://127.0.0.1:6379/5`). Every key they write sits under `ai-chat-95:` and is deleted when
 * the file finishes. Without the variable they are skipped; the connection tests still run.
 */
const redisUrl = process.env.TEST_REDIS_URL;
const testPrefix = "ai-chat-95:";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server that accepts TCP connections, counts them, and never answers: Redis-free. */
async function silentServer() {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted++;
    sockets.add(socket);
    // Read and discard, so the server notices when the client closes.
    socket.resume();
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${port}`,
    accepted: () => accepted,
    open: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A TCP proxy in front of the real Redis that counts every client connection it accepts. */
async function countingProxy(target: URL) {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((client) => {
    accepted++;
    sockets.add(client);
    const upstream = net.connect(Number(target.port || 6379), target.hostname);
    const end = () => {
      sockets.delete(client);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${port}${target.pathname}`,
    accepted: () => accepted,
    open: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("redisRuntime without Redis", () => {
  it("opens no connection while it is built, and createChat builds without one", async () => {
    const server = await silentServer();
    try {
      const runtime = redisRuntime({ url: server.url });
      createChat({
        databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
        getUser: () => null,
        keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
        basePath: "/api/chat",
        runtime,
      });
      await sleep(50);

      expect(server.accepted()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("opens connections on first use, and stop() closes them", async () => {
    const server = await silentServer();
    try {
      const runtime = redisRuntime({ url: server.url });
      const chat = createChat({
        databaseUrl: "postgresql://nobody:nothing@127.0.0.1:1/unreachable",
        getUser: () => null,
        keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
        basePath: "/api/chat",
        runtime,
      });

      // Never resolves: the server never answers the handshake. It must still be closable.
      void runtime.pubsub.publish("run:x:cancel", "stop").catch(() => {});
      await sleep(100);
      expect(server.accepted()).toBe(1);
      expect(server.open()).toBe(1);

      await chat.stop();
      await sleep(50);

      expect(server.open()).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe.skipIf(!redisUrl)("redisRuntime on a real Redis", () => {
  const connection: RedisConnection = createRedisConnection(redisUrl ?? "");

  afterAll(async () => {
    const client = await connection.command();
    const keys: string[] = [];
    // scanIterator yields one array of keys per SCAN page.
    for await (const page of client.scanIterator({ MATCH: `${testPrefix}*`, COUNT: 500 })) {
      keys.push(...page);
    }
    if (keys.length > 0) await client.del(keys);
    await connection.close();
  });

  pubsubContract("redis", () => createRedisPubSub(connection, testPrefix));

  runStreamsContract("redis", (options) => createRedisRunStreams(connection, testPrefix, options));

  counterStoreContract("redis", () => createRedisCounters(connection, testPrefix));

  it("keeps runtimes with different prefixes apart", async () => {
    const a = redisRuntime({ url: redisUrl!, prefix: `${testPrefix}a:` });
    const b = redisRuntime({ url: redisUrl!, prefix: `${testPrefix}b:` });
    try {
      const runId = crypto.randomUUID();
      await a.runStreams.open(runId);
      await a.runStreams.append(runId, {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m",
        delta: "a",
        timestamp: 0,
      } as StreamChunk);
      await a.runStreams.close(runId);
      const seenByB = [];
      for await (const entry of b.runStreams.read(runId, START)) seenByB.push(entry);
      expect(seenByB).toEqual([]);

      const heardByA: string[] = [];
      await a.pubsub.subscribe("run:x:cancel", (message) => heardByA.push(message));
      await b.pubsub.publish("run:x:cancel", "stop");
      await sleep(50);
      expect(heardByA).toEqual([]);
    } finally {
      await a.close?.();
      await b.close?.();
    }
  });

  it("holds one subscriber connection for many concurrent Runs", async () => {
    const proxy = await countingProxy(new URL(redisUrl!));
    const runtime = redisRuntime({ url: proxy.url, prefix: `${testPrefix}shared:` });
    try {
      const runIds = Array.from({ length: 20 }, () => crypto.randomUUID());
      for (const runId of runIds) {
        await runtime.pubsub.subscribe(`run:${runId}:cancel`, () => {});
      }
      await runtime.runStreams.open(runIds[0]!);
      await runtime.runStreams.append(runIds[0]!, {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m",
        delta: "x",
        timestamp: 0,
      } as StreamChunk);
      await runtime.runStreams.close(runIds[0]!);

      // One command connection and one subscriber connection, however many Runs are live.
      expect(proxy.accepted()).toBeLessThanOrEqual(2);
    } finally {
      await runtime.close?.();
      await proxy.close();
    }
  });

  it("close() leaves no open connection", async () => {
    const proxy = await countingProxy(new URL(redisUrl!));
    const runtime = redisRuntime({ url: proxy.url, prefix: `${testPrefix}close:` });
    try {
      await runtime.pubsub.subscribe("run:close:cancel", () => {});
      await runtime.pubsub.publish("run:close:cancel", "stop");
      expect(proxy.open()).toBeGreaterThan(0);

      await runtime.close?.();
      await sleep(50);

      expect(proxy.open()).toBe(0);
    } finally {
      await proxy.close();
    }
  });
});
