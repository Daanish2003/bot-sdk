const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached `Intl.DateTimeFormat` per locale and options, so a long list doesn't build one per row. */
export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter;
}
