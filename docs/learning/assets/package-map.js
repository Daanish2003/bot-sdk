// The map of ai-chat: the Host (apps/web), the four parts of the Chat SDK, and the Host's own
// packages, with who imports whom. Measured from the import lines in each folder (2026-10-14,
// branch main). Dashed edges are `import type` only: TypeScript erases them, so no code moves.
// Lessons reuse it to show where a step of the flow happens.
//
//   PackageMap.render("#map", { highlight: "server", onPick(id) {} });  // returns { select(id, opts) }
//   PackageMap.draw("server", { probe: { from: "client", to: "server", ok: false } });
(function () {
  const PACKAGES = [
    {
      id: "web",
      label: "apps/web (the Host)",
      path: "apps/web",
      x: 230,
      y: 14,
      w: 300,
      job: "The Host. It gives the SDK its users (getUser), one catch-all route and Postgres, and keeps login, env and logging.",
    },
    {
      id: "ui",
      label: "chat-sdk/ui",
      path: "packages/chat-sdk/ui",
      x: 140,
      y: 112,
      w: 230,
      sdk: true,
      job: "React components the Host owns and may change. Copied once; the copy script never overwrites them.",
    },
    {
      id: "client",
      label: "core/client",
      path: "packages/chat-sdk/core/client",
      x: 40,
      y: 212,
      w: 200,
      sdk: true,
      job: "The headless client (createChatClient) plus the React provider and hooks in client/react. Runs in the browser.",
    },
    {
      id: "server",
      label: "core/server",
      path: "packages/chat-sdk/core/server",
      x: 270,
      y: 212,
      w: 200,
      sdk: true,
      job: "Everything on the server: createChat, the handler, handleChat, the Run, the oRPC routers and the chat tables.",
    },
    {
      id: "shared",
      label: "core/shared",
      path: "packages/chat-sdk/core/shared",
      x: 140,
      y: 322,
      w: 230,
      sdk: true,
      job: "Code both sides use: Message parts, Models, Sources, error codes. It imports only npm packages.",
    },
    {
      id: "shadcn",
      label: "@ai-chat/ui",
      path: "packages/ui",
      x: 545,
      y: 112,
      w: 190,
      job: "The Host's shadcn primitives. chat-sdk/ui reaches them through the Host's @/components/ui alias.",
    },
    {
      id: "auth",
      label: "@ai-chat/auth",
      path: "packages/auth",
      x: 545,
      y: 192,
      w: 190,
      job: "Better Auth: users and sessions. Only the Host imports it; getUser asks it who the user is.",
    },
    {
      id: "email",
      label: "@ai-chat/email",
      path: "packages/email",
      x: 545,
      y: 266,
      w: 190,
      job: "The Host's emails (verify, reset). It imports no other package.",
    },
    {
      id: "db",
      label: "@ai-chat/db",
      path: "packages/db",
      x: 545,
      y: 340,
      w: 190,
      job: "The Host's own tables (Better Auth, Quota). Not the chat tables: those live in core/server/db, in the chat schema.",
    },
  ];
  const H = 44;
  /** from → the packages it imports. */
  const DEPS = {
    web: ["ui", "client", "server", "shadcn", "auth", "email", "db"],
    ui: ["client", "shared", "shadcn", "server"],
    client: ["shared", "server"],
    server: ["shared"],
    shared: [],
    shadcn: [],
    auth: ["db", "email"],
    email: [],
    db: [],
  };
  /** Edges that are `import type` only. */
  const TYPE_ONLY = new Set(["ui>server", "client>server"]);

  const byId = Object.fromEntries(PACKAGES.map((p) => [p.id, p]));
  const P = (x, y) => [x, y];
  // Hand-routed edges, so no line crosses a box.
  const ROUTES = {
    "web>ui": [P(300, 58), P(300, 112)],
    "web>client": [P(230, 30), P(24, 30), P(24, 234), P(40, 234)],
    "web>server": [P(450, 58), P(450, 212)],
    "web>shadcn": [P(530, 26), P(514, 26), P(514, 128), P(545, 128)],
    "web>auth": [P(530, 34), P(520, 34), P(520, 208), P(545, 208)],
    "web>email": [P(530, 42), P(526, 42), P(526, 282), P(545, 282)],
    "web>db": [P(530, 50), P(532, 50), P(532, 356), P(545, 356)],
    "ui>client": [P(200, 156), P(170, 212)],
    "ui>server": [P(320, 156), P(350, 212)],
    "ui>shared": [P(255, 156), P(255, 322)],
    "ui>shadcn": [P(370, 140), P(545, 140)],
    "client>shared": [P(140, 256), P(200, 322)],
    "client>server": [P(240, 234), P(270, 234)],
    "server>shared": [P(370, 256), P(310, 322)],
    "auth>email": [P(640, 236), P(640, 266)],
    "auth>db": [P(735, 214), P(750, 214), P(750, 362), P(735, 362)],
  };
  const center = (p) => [p.x + p.w / 2, p.y + H / 2];

  /** A straight probe arrow between any two boxes, from edge to edge. */
  function probePoints(from, to) {
    const a = byId[from],
      b = byId[to];
    const [ax, ay] = center(a),
      [bx, by] = center(b);
    const clip = (p, dx, dy) => {
      const sx = dx ? p.w / 2 / Math.abs(dx) : Infinity,
        sy = dy ? H / 2 / Math.abs(dy) : Infinity;
      const s = Math.min(sx, sy);
      return [dx * s, dy * s];
    };
    const [ox, oy] = clip(a, bx - ax, by - ay);
    const [ix, iy] = clip(b, ax - bx, ay - by);
    return [P(ax + ox, ay + oy), P(bx + ix, by + iy)];
  }

  function draw(selected, { probe = null } = {}) {
    const D = window.Diagrams;
    const frame =
      `<rect class="d-box ghost" x="14" y="92" width="472" height="290" rx="10"/>` +
      D.text(26, 396, "packages/chat-sdk (copied into a Host)", { tone: "muted", size: 12 });
    const edges = [];
    for (const [from, tos] of Object.entries(DEPS))
      for (const to of tos) edges.push({ from, to, on: from === selected, into: to === selected });
    edges.sort((e, f) => Number(e.on || e.into) - Number(f.on || f.into));
    const lines = edges.map((e) => {
      const key = `${e.from}>${e.to}`;
      return D.route(ROUTES[key], {
        tone: e.on ? "accent" : e.into ? "blue" : "faint",
        width: e.on || e.into ? 2.4 : 1.4,
        dashed: TYPE_ONLY.has(key),
        id: key,
      });
    });
    const boxes = PACKAGES.map((p) =>
      D.box(p.x, p.y, p.w, H, p.label, {
        tone: p.id === selected ? "accent" : "",
        mono: true,
        id: p.id,
        extra: "clickable",
      }),
    );
    const probeSvg = probe
      ? D.route(probePoints(probe.from, probe.to), {
          tone: probe.ok ? "ok" : "accent",
          width: 3,
          dashed: Boolean(probe.typeOnly),
        })
      : "";
    const legend = selected
      ? D.text(26, 414, "red = imports · blue = imported by · dashed = import type only", {
          tone: "muted",
          size: 12,
        })
      : D.text(26, 414, "Click a box to see its job and its imports · dashed = import type only", {
          tone: "muted",
          size: 12,
        });
    return frame + lines.join("") + boxes.join("") + probeSvg + legend;
  }

  function render(selector, { highlight = null, onPick } = {}) {
    const el = typeof selector === "string" ? document.querySelector(selector) : selector;
    const holder = document.createElement("div");
    el.prepend(holder);
    const select = (id, opts) => {
      holder.innerHTML = window.Diagrams.svg(760, 424, draw(id, opts), {
        label:
          "The Host, the four parts of the Chat SDK and the Host's packages, with their imports",
      });
      holder.querySelectorAll("[data-id]").forEach((g) =>
        g.addEventListener("click", () => {
          select(g.dataset.id);
          onPick?.(g.dataset.id);
        }),
      );
    };
    select(highlight);
    return { select };
  }

  const importedBy = (id) => Object.keys(DEPS).filter((k) => DEPS[k].includes(id));
  window.PackageMap = { PACKAGES, DEPS, TYPE_ONLY, byId, importedBy, render, draw };
})();
