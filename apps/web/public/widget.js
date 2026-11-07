/*
 * The web chat widget (ticket #1340). One script tag on any page:
 *
 *   <script src="https://your-host/widget.js" data-key="PUBLIC_KEY" defer></script>
 *
 * It holds the Representative's public key and nothing secret. It reads `data-api` for the SDK's base
 * path, else uses `/api/chat` on the script's own origin. Every text it shows, a visitor's or the
 * Representative's, is set with `textContent`, so none of it is ever parsed as HTML.
 */
(() => {
  const script = document.currentScript;
  const key = script && script.dataset.key;
  if (!key) {
    console.error("The chat widget needs data-key on its script tag.");
    return;
  }
  const base = (script.dataset.api || new URL(script.src).origin + "/api/chat").replace(/\/$/, "");
  const api = base + "/representative/widget";
  const storeName = "botsdk-widget:" + key;

  // The token keeps a visitor's thread across a reload. Storage can be blocked: then it lasts the page.
  let memoryToken = null;
  const loadToken = () => {
    try {
      return localStorage.getItem(storeName) || memoryToken;
    } catch {
      return memoryToken;
    }
  };
  const saveToken = (token) => {
    memoryToken = token;
    try {
      if (token) localStorage.setItem(storeName, token);
      else localStorage.removeItem(storeName);
    } catch {
      // The token still lasts this page.
    }
  };

  /* The page. Plain elements in a shadow root, so the host page's styles don't reach it. */
  const element = (tag, attributes = {}, text) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const host = element("div", { "data-chat-widget": "" });
  const shadow = host.attachShadow({ mode: "open" });
  const style = element(
    "style",
    {},
    `:host { all: initial; font: 14px/1.4 system-ui, sans-serif; }
     .panel { position: fixed; right: 16px; bottom: 16px; width: min(360px, calc(100vw - 32px)); height: min(480px, calc(100vh - 32px)); display: flex; flex-direction: column; background: #fff; color: #111; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.2); }
     .log { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
     .message { max-width: 85%; padding: 6px 10px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
     .message[data-from="customer"] { align-self: flex-end; background: #dbeafe; }
     .message[data-from="business"] { align-self: flex-start; background: #f1f1f1; }
     .status { padding: 6px 10px; border-top: 1px solid #ddd; background: #fffbe6; }
     .status:empty { display: none; }
     form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #ddd; }
     input { flex: 1; min-width: 0; padding: 6px; font: inherit; }
     button { font: inherit; }
     [hidden] { display: none; }
     .verify { align-self: flex-start; margin: 0 8px; padding: 0; border: 0; background: none; color: #1d4ed8; text-decoration: underline; cursor: pointer; }`,
  );
  const log = element("div", { class: "log", role: "log", "aria-live": "polite" });
  const status = element("div", { class: "status", role: "status" });
  const field = element("input", {
    type: "text",
    "aria-label": "Your message",
    autocomplete: "off",
  });
  const sendButton = element("button", { type: "submit" }, "Send");
  const form = element("form");
  form.append(field, sendButton);
  const restart = element("button", { type: "button", hidden: "" }, "Start a new chat");

  /*
   * Verifying by a code sent to an email address on record (ticket #1350): the address and the code
   * go only to their own routes, never into the chat, so no Model reads them.
   */
  const verifyButton = element("button", { type: "button", class: "verify" }, "Verify by email");
  const emailField = element("input", {
    type: "email",
    "aria-label": "Your email address",
    autocomplete: "email",
  });
  const emailForm = element("form", { hidden: "" });
  emailForm.append(emailField, element("button", { type: "submit" }, "Send code"));
  const codeField = element("input", {
    type: "text",
    "aria-label": "Code from the email",
    autocomplete: "one-time-code",
    inputmode: "numeric",
  });
  const codeForm = element("form", { hidden: "" });
  codeForm.append(codeField, element("button", { type: "submit" }, "Verify"));

  const panel = element("section", { class: "panel", "aria-label": "Chat" });
  panel.append(log, status, restart, verifyButton, emailForm, codeForm, form);
  shadow.append(style, panel);

  const say = (text) => {
    status.textContent = text;
  };
  const show = (messages) => {
    log.replaceChildren(
      ...messages.map((message) =>
        element("div", { class: "message", "data-from": message.from }, message.text),
      ),
    );
    log.scrollTop = log.scrollHeight;
  };
  const setUsable = (usable) => {
    field.disabled = !usable;
    sendButton.disabled = !usable;
    verifyButton.disabled = !usable;
  };
  /** Shows one step of verifying, or none. */
  const verifyStep = (step) => {
    emailForm.hidden = step !== "email";
    codeForm.hidden = step !== "code";
  };

  /* The session. */
  let token = null;
  let following = 0;
  let stream = null;

  const post = (path, body, signal) =>
    // A string body goes as text/plain, which a browser sends across origins with no preflight.
    fetch(api + "/" + path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

  const end = () => {
    token = null;
    following++;
    if (stream) stream.abort();
    saveToken(null);
    setUsable(false);
    verifyStep(null);
    restart.hidden = false;
    say("Your chat session has ended.");
  };

  let reading = false;
  let readAgain = false;
  async function refresh() {
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    try {
      do {
        readAgain = false;
        const own = token;
        if (!own) return;
        const response = await post("read", { token: own });
        if (response.status === 401) return own === token ? end() : undefined;
        if (response.ok && own === token) show((await response.json()).messages);
      } while (readAgain);
    } catch {
      // The next hint or send reads again.
    } finally {
      reading = false;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Re-reads on every hint, and reconnects when the connection drops. */
  async function follow() {
    const turn = ++following;
    if (stream) stream.abort();
    const mine = new AbortController();
    stream = mine;
    const own = token;
    let wait = 1000;
    while (turn === following) {
      try {
        const response = await post("stream", { token: own }, mine.signal);
        if (turn !== following) return;
        if (response.status === 401) return end();
        if (response.status === 429) {
          await sleep(Number(response.headers.get("retry-after")) * 1000 || 30_000);
          continue;
        }
        if (response.ok && response.body) {
          wait = 1000;
          const decoder = new TextDecoder();
          let pending = "";
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const event = JSON.parse(line.slice(6));
              if (event.type === "changed") void refresh();
              else if (event.type === "ended") return turn === following ? end() : undefined;
            }
          }
        }
      } catch {
        // A dropped connection: ask again below.
      }
      if (turn !== following) return;
      await sleep(wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }

  /** Starts a session, or says why there's none. */
  async function startSession() {
    try {
      const response = await post(key + "/session");
      if (!response.ok) {
        setUsable(false);
        say("Chat isn't available on this page.");
        return false;
      }
      token = (await response.json()).token;
      saveToken(token);
      return true;
    } catch {
      setUsable(false);
      say("Chat isn't available right now.");
      return false;
    }
  }

  async function begin() {
    restart.hidden = true;
    say("");
    token = loadToken();
    if (token) {
      try {
        const response = await post("read", { token });
        // A stored session can end between visits: a new one takes its place, with nothing to say.
        if (response.status === 401) {
          token = null;
          saveToken(null);
        } else if (response.ok) {
          show((await response.json()).messages);
        }
      } catch {
        // The stream's first hint reads again.
      }
    }
    if (!token && !(await startSession())) return;
    setUsable(true);
    // Its first hint reads the thread.
    void follow();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = field.value.trim();
    if (!text || !token) return;
    const own = token;
    setUsable(false);
    say("");
    try {
      const response = await post("send", { token: own, text });
      if (response.status === 401) return end();
      if (response.status === 202) {
        field.value = "";
      } else if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        // The inbound limit can ask for most of an hour, which reads better in minutes.
        const wait = seconds > 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
        say(
          seconds ? `You're sending too fast. Try again in ${wait}.` : "You're sending too fast.",
        );
      } else {
        say("That message can't be sent.");
      }
    } catch {
      // The page can't tell whether it arrived, and a send is not retried by itself.
      say("Couldn't tell if that was sent. Check the chat before you send it again.");
    }
    if (token) {
      setUsable(true);
      field.focus();
    }
    await refresh();
  });
  /** Says how long to wait after a 429, in the words a send's limit uses. */
  const tooFast = (response) => {
    const seconds = Number(response.headers.get("retry-after"));
    const wait = seconds > 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
    say(seconds ? `Too many tries. Try again in ${wait}.` : "Too many tries.");
  };

  verifyButton.addEventListener("click", () => {
    say("");
    verifyStep("email");
    emailField.focus();
  });

  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailField.value.trim();
    if (!email || !token) return;
    try {
      const response = await post("code", { token, email });
      if (response.status === 401) return end();
      if (response.status === 202) {
        // The same whatever the address: the route never says whether it is on record.
        say("If that address is on record, we've emailed a code to it. Enter it below.");
        verifyStep("code");
        codeField.focus();
      } else if (response.status === 429) {
        tooFast(response);
      } else {
        say("Enter an email address.");
      }
    } catch {
      say("Couldn't ask for a code. Try again.");
    }
  });

  codeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = codeField.value.trim();
    if (!code || !token) return;
    try {
      const response = await post("code/check", { token, code });
      if (response.status === 401) return end();
      if (response.ok) {
        codeField.value = "";
        emailField.value = "";
        verifyStep(null);
        say("You're verified.");
      } else if (response.status === 429) {
        tooFast(response);
      } else {
        say("That code is wrong or has expired. Ask for a new one if you need to.");
      }
    } catch {
      say("Couldn't check the code. Try again.");
    }
  });

  restart.addEventListener("click", () => {
    setUsable(false);
    show([]);
    void begin();
  });

  setUsable(false);
  const mount = () => {
    document.body.append(host);
    void begin();
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
