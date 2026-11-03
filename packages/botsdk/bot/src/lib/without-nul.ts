/**
 * `value` with the NULs dropped from each string in it, through arrays and plain objects: Postgres
 * takes none in text or jsonb. For what comes from outside with no one to refuse it to, as a
 * Channel's message does: a throw would only have it delivered again, and lost in the end.
 */
export function withoutNul<Value>(value: Value): Value {
  if (typeof value === "string") return value.replaceAll("\u0000", "") as Value;
  if (Array.isArray(value)) return value.map((each) => withoutNul(each)) as Value;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, withoutNul(each)]),
    ) as Value;
  }
  return value;
}
