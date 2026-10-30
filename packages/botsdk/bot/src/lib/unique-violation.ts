/**
 * Whether Postgres refused a write on the unique constraint (or primary key) named `constraint`.
 * The query layer wraps the driver's error, so this follows the `cause` chain.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const { code, constraint: name } = current as { code?: unknown; constraint?: unknown };
    if (code === "23505" && name === constraint) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
