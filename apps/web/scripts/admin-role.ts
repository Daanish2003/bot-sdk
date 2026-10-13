/// <reference types="node" />
/**
 * Grants or revokes a user's Admin role by email (spec #277), printing the user it changed:
 * `pnpm --filter web admin:grant <email>` and `pnpm --filter web admin:revoke <email>`. The only
 * way to change a role: nothing in the UI or the environment can.
 *
 * Plain Node (type stripping), so the workspace packages' extensionless imports are resolved by the
 * hook below before they load, as `rotate-keys.ts` does.
 */
import { registerHooks } from "node:module";

import { log } from "evlog";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // Try the next form of the path.
        }
      }
      throw error;
    }
  },
});

const { createDb } = await import("@ai-chat/db");
const { setUserRole } = await import("@ai-chat/auth/roles");

const [action, email] = process.argv.slice(2);
if ((action !== "grant" && action !== "revoke") || !email) {
  console.error("Usage: admin-role.ts <grant|revoke> <email>");
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL");

const db = createDb({ DATABASE_URL: databaseUrl });
const changed = await setUserRole(db, email, action === "grant" ? "admin" : "user");
if (!changed) {
  console.error(`No user has the email ${email}`);
  process.exit(1);
}
console.log(JSON.stringify(changed));
// One structured event per Admin action (spec #277): the actor is the operator running this script.
log.info({
  action: `admin.role.${action}`,
  message: `Admin role ${action === "grant" ? "granted" : "revoked"} by the operator script`,
  actor: "operator-script",
  target: changed.id,
});
// The database pool has no public close; a one-off command exits once it has printed.
process.exit(0);
