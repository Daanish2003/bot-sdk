import type pg from "pg";

import type { BotSdkContext } from "../plugin";
import {
  CredentialsRejectedError,
  type MessagingAccount,
  type MessagingAdapter,
} from "../channel/internal";
import { activeChannelAccountIds, listenerAccount, markNeedsAttention } from "./conversation";
import { receiveMessaging } from "./turn";

/*
 * The Channel accounts' listeners (spec #1044): one per active account whose adapter listens, for
 * as long as the SDK runs. Listeners aren't runner jobs: no Executor holds a socket. Each one holds
 * a session advisory lock on its account, so of several SDK instances over one database only one
 * listens to an account.
 */

/** The PubSub channel a change to a Channel account is published on, by its id. */
const accountsChannel = "botsdk:channel-accounts";

/** How often each instance looks for accounts with no listener, and how a failing one backs off. */
export type ListenerTiming = { syncMs: number; backoffMinMs: number; backoffMaxMs: number };

const defaultTiming: ListenerTiming = { syncMs: 30_000, backoffMinMs: 1_000, backoffMaxMs: 60_000 };

/**
 * Tells every instance's listeners that the Channel accounts `ids` changed (saved, removed, deleted
 * with their Bot, or let go by an instance that stopped), so each starts or stops its listener.
 * Never throws: an instance that misses it catches up on its next sync.
 */
export async function accountsChanged(sdk: BotSdkContext, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await sdk.pubsub.publish(accountsChannel, JSON.stringify({ id }));
    } catch (caught) {
      sdk.logger.error(`Publishing a change of Channel account ${id} failed`, caught);
    }
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

type Listener = { version: string; abort: AbortController; done: Promise<void> };

/** The advisory lock key of a Channel account. */
const lockKey = (id: string) => `channel_account:${id}`;

/**
 * The listeners of the Channel accounts on `adapters`, whose notices link into the app at `appUrl`
 * (`null` when the Host has none), started by the `channel` plugin's `start`
 * and stopped by its `stop`. Every change to which listeners run goes through one queue, so a
 * save, a sync and a stop never interleave.
 */
export function channelListeners(
  sdk: BotSdkContext,
  adapters: readonly MessagingAdapter[],
  appUrl: string | null,
  timing: ListenerTiming = defaultTiming,
) {
  const listening = adapters.filter((adapter) => adapter.listen);
  const running = new Map<string, Listener>();
  let session: pg.PoolClient | null = null;
  let started = false;
  let unsubscribe: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let queue: Promise<void> = Promise.resolve();

  const serial = (work: () => Promise<void>) => {
    const next = queue
      .then(work)
      .catch((error) => sdk.logger.error("Starting or stopping a Channel listener failed", error));
    queue = next;
    return next;
  };

  const onSessionError = (error: Error) => dropSession(error);

  /** The one session the instance's locks are held on, opened on first use. */
  async function lockSession(): Promise<pg.PoolClient> {
    if (session) return session;
    const client = await (sdk.db.$client as pg.Pool).connect();
    client.on("error", onSessionError);
    session = client;
    return client;
  }

  /** Hands the session back to the pool, destroying the connection on `error`. */
  function releaseSession(error?: Error) {
    const client = session;
    if (!client) return;
    session = null;
    client.off("error", onSessionError);
    client.release(error);
  }

  /**
   * The session failed: its locks went with it (the connection is destroyed), so every listener
   * stops, and the next sync takes the accounts again.
   */
  function dropSession(error: Error) {
    if (!session) return;
    sdk.logger.error("The Channel listeners' database session failed", error);
    releaseSession(error);
    for (const id of running.keys()) void serial(() => halt(id, false));
  }

  async function tryLock(id: string): Promise<boolean> {
    const client = await lockSession();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
        [lockKey(id)],
      );
      return rows[0]?.locked === true;
    } catch (error) {
      dropSession(error as Error);
      throw error;
    }
  }

  /** Lets go of account `id`'s lock. Never throws: a failed session drops every lock. */
  async function unlock(id: string) {
    if (!session) return;
    try {
      await session.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey(id)]);
    } catch (error) {
      dropSession(error as Error);
    }
  }

  /** Stops account `id`'s listener, and lets go of its lock unless the session is gone. */
  async function halt(id: string, release = true) {
    const listener = running.get(id);
    if (!listener) return;
    running.delete(id);
    listener.abort.abort();
    await listener.done;
    if (release) await unlock(id);
  }

  /** Listens to `account` until its listener aborts; a rejection marks it and ends, other errors retry. */
  async function run(
    adapter: MessagingAdapter,
    account: MessagingAccount & { platform: string },
    listener: Listener,
  ) {
    const { signal } = listener.abort;
    let failures = 0;
    while (!signal.aborted) {
      const began = Date.now();
      try {
        await adapter.listen!(account, {
          fetch: sdk.fetch,
          signal,
          receive: (update) => receiveMessaging(sdk, adapter, account, update, appUrl),
        });
        if (signal.aborted) return;
        throw new Error("The listener ended by itself");
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof CredentialsRejectedError) {
          // No retry until the user saves new credentials: the account needs attention.
          let marked = true;
          try {
            await markNeedsAttention(sdk, account.id, listener.version, error.reason);
          } catch (caught) {
            marked = false;
            sdk.logger.error("Marking a Channel account as needing attention failed", caught);
          }
          void serial(async () => {
            if (running.get(account.id) !== listener) return;
            running.delete(account.id);
            await unlock(account.id);
            // Unmarked, it waits for the next sync rather than looping on rejected credentials.
            if (marked) await reconcile(account.id);
          });
          return;
        }
        sdk.logger.error(`A ${adapter.id} Channel account's listener failed; retrying`, error);
        // A listener that ran a while before failing starts its back-off over.
        failures = Date.now() - began > timing.backoffMaxMs ? 1 : failures + 1;
      }
      await pause(Math.min(timing.backoffMinMs * 2 ** (failures - 1), timing.backoffMaxMs), signal);
    }
  }

  /** Starts, restarts or stops account `id`'s listener to match its row. */
  async function reconcile(id: string) {
    if (!started) return;
    const found = await listenerAccount(sdk, id);
    const adapter = found && listening.find((candidate) => candidate.id === found.platform);
    if (found?.status === "active" && adapter && !found.account) {
      // No key of the keyring reads the credentials: only saving them again fixes it.
      await markNeedsAttention(sdk, id, found.version, "The saved credentials can't be read");
    }
    const account = found?.status === "active" && adapter ? found.account : null;
    const current = running.get(id);
    if (current && (!account || current.version !== found!.version)) await halt(id);
    if (!account || !adapter || running.has(id)) return;
    if (!(await tryLock(id))) return;
    const abort = new AbortController();
    const listener: Listener = { version: found!.version, abort, done: Promise.resolve() };
    running.set(id, listener);
    listener.done = run(adapter, { ...account, platform: adapter.id }, listener);
  }

  /** Reconciles every running listener and every active account. */
  async function sync() {
    if (!started) return;
    const active = await activeChannelAccountIds(
      sdk,
      listening.map((adapter) => adapter.id),
    );
    for (const id of new Set([...running.keys(), ...active])) await reconcile(id);
  }

  return {
    /** Starts a listener for each active account this instance can lock, and follows changes. */
    start: async () => {
      if (listening.length === 0 || started) return;
      started = true;
      unsubscribe = await sdk.pubsub.subscribe(accountsChannel, (message) => {
        const { id } = JSON.parse(message) as { id: string };
        void serial(() => reconcile(id));
      });
      await serial(sync);
      timer = setInterval(() => void serial(sync), timing.syncMs);
      timer.unref?.();
    },
    /** Stops every listener, lets go of their locks, and tells the other instances to take over. */
    stop: async () => {
      if (!started) return;
      started = false;
      clearInterval(timer);
      await unsubscribe?.();
      await serial(async () => {
        const ids = [...running.keys()];
        // `halt` doesn't throw: a failed unlock drops the session, and every lock with it.
        for (const id of ids) await halt(id);
        releaseSession();
        await accountsChanged(sdk, ids);
      });
    },
  };
}
