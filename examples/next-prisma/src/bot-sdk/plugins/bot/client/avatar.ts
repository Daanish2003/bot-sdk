/** A Bot's initials for its avatar: the first letter of its first two words. */
export function botInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join("");
}

/** A Bot's avatar colour: a hue from its name, so one name always gets one colour. */
export function botColour(name: string): string {
  const hue = [...name].reduce((sum, char) => sum + char.codePointAt(0)!, 0) % 360;
  return `hsl(${hue} 55% 45%)`;
}
