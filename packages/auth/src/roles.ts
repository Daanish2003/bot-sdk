import type { Database } from "@ai-chat/db";
import { user } from "@ai-chat/db/schema/auth";
import { eq } from "drizzle-orm";

export type Role = "admin" | "user";

/**
 * Sets a user's role by email (spec #277): the operator's grant and revoke, run from a repo
 * script, never through the UI. Returns the user it changed, or `null` when no user has the email.
 */
export async function setUserRole(
  database: Database,
  email: string,
  role: Role,
): Promise<{ id: string; email: string; role: Role } | null> {
  const [updated] = await database
    .update(user)
    .set({ role })
    .where(eq(user.email, email.trim().toLowerCase()))
    .returning({ id: user.id, email: user.email });
  return updated ? { ...updated, role } : null;
}
