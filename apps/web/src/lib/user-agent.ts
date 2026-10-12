/** A short name for the browser and system that sent a user agent, such as "Chrome on Windows". */
export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";

  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;

  const system = /iPhone|iPad|iPod/.test(userAgent)
    ? /iPhone/.test(userAgent)
      ? "iPhone"
      : "iPad"
    : /Android/.test(userAgent)
      ? "Android"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Macintosh|Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux|X11/.test(userAgent)
            ? "Linux"
            : null;

  if (!browser && !system) return "Unknown device";
  if (!browser) return system ?? "Unknown device";
  if (!system) return browser;
  return `${browser} on ${system}`;
}
