import type { Database } from "../../storage";
import type { Transaction } from "../../plugin";

type Hooks = (() => void)[];

/** Each open transaction's after-commit hooks; a savepoint's join its parent's once it releases. */
const hooksOf = new WeakMap<object, Hooks>();
const tracked = new WeakSet<object>();

/** Has `tx`, and each savepoint opened in it, collect hooks into `hooks`. */
function track(tx: Transaction, hooks: Hooks): void {
  hooksOf.set(tx, hooks);
  type Savepoint = <T>(fn: (inner: Transaction) => Promise<T>) => Promise<T>;
  const savepoint = tx.transaction.bind(tx) as Savepoint;
  const tracking: Savepoint = (fn) =>
    savepoint(async (inner) => {
      const own: Hooks = [];
      track(inner, own);
      const result = await fn(inner);
      // Released, so its hooks run if the parent commits. A rolled-back savepoint drops them.
      hooks.push(...own);
      return result;
    });
  tx.transaction = tracking as Transaction["transaction"];
}

/**
 * Has `db`'s transactions run their `afterCommit` hooks once they commit, and drop them when they
 * roll back. Idempotent, so every instance over one database can call it.
 */
export function trackCommits(db: Database): void {
  if (tracked.has(db)) return;
  tracked.add(db);
  const transaction = db.transaction.bind(db);
  db.transaction = (async (fn, config) => {
    const hooks: Hooks = [];
    const result = await transaction((tx) => {
      track(tx, hooks);
      return fn(tx);
    }, config);
    for (const hook of hooks) hook();
    return result;
  }) as Database["transaction"];
}

/**
 * Runs `hook` once `tx` commits, or never if it rolls back. For a transaction no `trackCommits`
 * call covers (a Host's own Drizzle instance), whose commit nothing sees, it never runs.
 */
export function afterCommit(tx: Transaction, hook: () => void): void {
  hooksOf.get(tx)?.push(hook);
}
