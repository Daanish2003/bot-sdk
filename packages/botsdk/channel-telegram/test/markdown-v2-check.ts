/**
 * What Telegram's MarkdownV2 parser and nesting rules refuse (Bot API "Formatting options"), for the
 * fake Bot API to reject as Telegram would: the first problem in `text`, or `null`. Stricter than
 * Telegram in one place: no inline entity may run over a line end inside a quote.
 */
export function markdownV2Problem(text: string): string | null {
  const open: string[] = [];
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at] as string;
    if (char === "\\") {
      const next = text.charCodeAt(at + 1);
      if (!(next >= 1 && next <= 126)) return `a backslash at ${at} escapes nothing`;
      at++;
    } else if (char === "\n") {
      quoted = quoted && text[at + 1] === ">";
      if (quoted && open.length > 0) return `${open.at(-1)} runs over a line end in a quote`;
      if (quoted) at++;
    } else if (char === ">") {
      if (at > 0 && text[at - 1] !== "\n") return `a stray > at ${at}`;
      if (open.length > 0) return `a quote inside ${open.at(-1)} at ${at}`;
      quoted = true;
    } else if (char === "`") {
      if (open.length > 0) return `code inside ${open.at(-1)} at ${at}`;
      const fence = text.startsWith("```", at) ? "```" : "`";
      if (fence === "```" && quoted) return `a code block inside a quote at ${at}`;
      let end = at + fence.length;
      while (end < text.length && !text.startsWith(fence, end)) {
        if (text[end] === "`") return `a stray backtick in code at ${end}`;
        end += text[end] === "\\" ? 2 : 1;
      }
      if (end >= text.length) return `code left open at ${at}`;
      if (fence === "```" && text.slice(at, end).indexOf("\n") < 0)
        return `no line in a code block`;
      at = end + fence.length - 1;
    } else if (char === "*" || char === "_" || char === "~") {
      if (char === "_" && text[at + 1] === "_") return `__ reads as underline at ${at}`;
      if (open.at(-1) === char) open.pop();
      else if (open.includes(char)) return `${char} closes across another entity at ${at}`;
      else open.push(char);
    } else if (char === "[") {
      if (open.includes("[")) return `a link inside a link at ${at}`;
      open.push("[");
    } else if (char === "]") {
      if (open.at(-1) !== "[") return `a stray ] at ${at}`;
      open.pop();
      if (text[at + 1] !== "(") return `a link with no address at ${at}`;
      let end = at + 2;
      while (end < text.length && text[end] !== ")") end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) return `a link's address left open at ${at}`;
      at = end;
    } else if ("()#+-=|{}.!".includes(char)) {
      return `an unescaped ${char} at ${at}`;
    }
  }
  return open.length > 0 ? `${open.at(-1)} left open` : null;
}
