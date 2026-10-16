// Draws a Conversation's Message tree top-down: roots on the first row, each Message under its
// parent, siblings left to right oldest first. Lessons 5, 6 and later (Shared links) reuse it.
//
// A node is { id, parentId, at } where `at` is the minute it was created (the real code uses
// `createdAt`, a Date). Ids starting with "q" are user Messages; the rest are assistant Messages.
//
//   MessageTree.SAMPLE                       the tree from packages/chat-sdk/test/core/shared/chat/branches.test.ts
//   MessageTree.draw(nodes, opts) → svg inner string
//   MessageTree.render(selector, nodes, opts) → { update(nodes?, opts?) }
//
// opts: path (ids drawn red, with red edges), activeLeaf (id with an "activeLeafId" tag),
// fresh (ids drawn as new, dashed), tags ({ id: "‹ 1/2 ›" } shown right of a node),
// onPick(id) (render only: click a node).
(function () {
  const SAMPLE = [
    { id: "q1", parentId: null, at: 0 },
    { id: "a1", parentId: "q1", at: 1 },
    { id: "q2", parentId: "a1", at: 2 },
    { id: "a2", parentId: "q2", at: 3 },
    { id: "a1b", parentId: "q1", at: 4 },
    { id: "q2b", parentId: "a1", at: 5 },
    { id: "a2b", parentId: "q2b", at: 6 },
    { id: "q1b", parentId: null, at: 7 },
    { id: "a1c", parentId: "q1b", at: 8 },
  ];
  const byAge = (a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const isUser = (id) => id.startsWith("q");

  function layout(nodes, width = 760) {
    const kids = new Map();
    for (const n of nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
    for (const list of kids.values()) list.sort(byAge);
    const pos = new Map();
    let slot = 0,
      depthMax = 0;
    const place = (n, depth) => {
      depthMax = Math.max(depthMax, depth);
      const below = kids.get(n.id) ?? [];
      if (!below.length) pos.set(n.id, { slot: slot++, depth });
      else {
        below.forEach((c) => place(c, depth + 1));
        const xs = below.map((c) => pos.get(c.id).slot);
        pos.set(n.id, { slot: (xs[0] + xs[xs.length - 1]) / 2, depth });
      }
    };
    (kids.get(null) ?? []).forEach((r) => place(r, 0));
    const slotW = Math.min(170, (width - 40) / Math.max(1, slot));
    const x0 = (width - slot * slotW) / 2 + slotW / 2;
    const out = new Map();
    for (const [id, p] of pos) out.set(id, { x: x0 + p.slot * slotW, y: 34 + p.depth * 70 });
    return { pos: out, height: 34 + depthMax * 70 + 64 };
  }

  function draw(nodes, { path = [], activeLeaf = null, fresh = [], tags = {}, width = 760 } = {}) {
    const D = window.Diagrams;
    const { pos } = layout(nodes, width);
    const on = new Set(path);
    const W = 78,
      H = 36;
    const edges = nodes
      .filter((n) => n.parentId && pos.has(n.parentId))
      .map((n) => {
        const a = pos.get(n.parentId),
          b = pos.get(n.id);
        const hot = on.has(n.id) && on.has(n.parentId);
        return `<line class="d-line ${hot ? "accent" : ""} ${fresh.includes(n.id) ? "dashed" : ""}" stroke-width="${hot ? 2.8 : 1.5}" x1="${a.x}" y1="${a.y + H / 2}" x2="${b.x}" y2="${b.y - H / 2}"/>`;
      });
    const boxes = nodes.map((n) => {
      const { x, y } = pos.get(n.id);
      const tone = on.has(n.id)
        ? "accent"
        : fresh.includes(n.id)
          ? "warn"
          : isUser(n.id)
            ? "blue"
            : "";
      let s = D.box(x - W / 2, y - H / 2, W, H, n.id, {
        tone,
        mono: true,
        sub: `${isUser(n.id) ? "user" : "reply"} · m${n.at}`,
        id: n.id,
        extra: "clickable",
      });
      if (tags[n.id])
        s += D.text(x + W / 2 + 4, y, tags[n.id], {
          tone: "accent",
          size: 13,
          weight: 600,
          mono: true,
        });
      if (n.id === activeLeaf)
        s +=
          D.arrow(x, y + H / 2 + 26, x, y + H / 2 + 3, { tone: "accent" }) +
          D.text(x, y + H / 2 + 36, "activeLeafId", {
            tone: "accent",
            size: 12,
            anchor: "middle",
            mono: true,
          });
      return s;
    });
    return edges.join("") + boxes.join("");
  }

  function render(selector, nodes, opts = {}) {
    const el = typeof selector === "string" ? document.querySelector(selector) : selector;
    const holder = document.createElement("div");
    el.prepend(holder);
    let state = { nodes, opts };
    const update = (n = state.nodes, o = state.opts) => {
      state = { nodes: n, opts: o };
      const { height } = layout(n, o.width);
      holder.innerHTML = window.Diagrams.svg(o.width ?? 760, height, draw(n, o), {
        label: o.label ?? "A Conversation's Message tree",
      });
      if (o.onPick)
        holder
          .querySelectorAll("[data-id]")
          .forEach((g) => g.addEventListener("click", () => o.onPick(g.dataset.id)));
    };
    update();
    return { update };
  }

  window.MessageTree = { SAMPLE, byAge, isUser, layout, draw, render };
})();
