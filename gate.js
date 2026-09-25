// gate.js — the soft mailing-list nudge on the browser tools.
//
// never blocks anything: the file is already downloading when this shows. a
// small window docks bottom-right with an email field and a "no thanks".
//
//   - first export ever: nothing. from the second export on (counted across
//     every tool), the window may show.
//   - "no thanks" / × / Esc snoozes it for 30 days, site-wide.
//   - a known email (newspeech.email — shared with the plugin gates, Night
//     School and the homepage box) means it never shows at all.
//
// usage: <script src="gate.js"></script>, then after the page's download
// fires: window.NewspeechGate && NewspeechGate.afterExport("texture").
// posts to /api/subscribe with source "tools" + the tool name; locally that
// needs `netlify dev` for the function.
(function () {
  "use strict";
  if (window.NewspeechGate) return; // idempotent

  const EMAIL_KEY = "newspeech.email";
  const COUNT_KEY = "newspeech.exports";
  const SNOOZE_KEY = "newspeech.nudgeSnooze";
  const SNOOZE_MS = 30 * 24 * 3600 * 1000;
  const FIRST_AT = 2; // export count that first earns the window
  const DELAY_MS = 900; // let the download start before anything appears

  const get = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

  const CSS = `
  #ns-nudge {
    position: fixed; right: 16px; bottom: 16px; z-index: 40;
    width: min(380px, calc(100vw - 32px));
    display: flex; flex-direction: column;
    border: 1px solid rgba(255,255,255,.28); background: rgba(5,5,5,.94);
    box-shadow: 0 0 0 1px rgba(0,0,0,.9), 0 18px 40px rgba(0,0,0,.55);
    font: 12px/18px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.04em; color: #eee;
    opacity: 0; transform: translateY(8px); transition: opacity .35s, transform .35s;
  }
  #ns-nudge.in { opacity: 1; transform: none; }
  #ns-nudge .bar {
    display: flex; align-items: center; gap: 8px; height: 22px; padding: 0 8px;
    border-bottom: 1px solid rgba(255,255,255,.22); background: rgba(255,255,255,.04); user-select: none;
  }
  #ns-nudge .idx { font-size: 10px; letter-spacing: 0.2em; opacity: .4; }
  #ns-nudge .title { font-family: "zxx-sans", ui-monospace, monospace; font-size: 10px; letter-spacing: 0.18em; text-transform: lowercase; }
  #ns-nudge .x { margin-left: auto; background: none; border: 0; color: inherit; font: inherit; opacity: .5; cursor: pointer; padding: 0 2px; line-height: 1; }
  #ns-nudge .x:hover { opacity: 1; }
  #ns-nudge .body { display: flex; flex-direction: column; gap: 14px; padding: 20px 22px 18px; }
  #ns-nudge .hp { display: none; }
  #ns-nudge .lbl { opacity: .55; }
  #ns-nudge .row { display: flex; gap: 10px; }
  #ns-nudge input[type="email"] {
    flex: 1 1 auto; min-width: 0; background: transparent; border: 1px solid rgba(255,255,255,.45); color: #eee;
    font: inherit; letter-spacing: 0.04em; padding: 7px 12px; border-radius: 0; outline: none;
  }
  #ns-nudge input[type="email"]:focus { border-color: rgba(255,255,255,.9); }
  #ns-nudge input[type="email"]::placeholder { color: rgba(255,255,255,.3); }
  #ns-nudge .go {
    flex: 0 0 auto; background: transparent; border: 1px solid rgba(255,255,255,.7); color: #eee; font: inherit;
    letter-spacing: 0.04em; padding: 7px 14px; cursor: pointer; white-space: nowrap; border-radius: 0;
  }
  #ns-nudge .go:hover { background: rgba(255,255,255,.08); }
  #ns-nudge .go:disabled { opacity: .4; cursor: default; }
  #ns-nudge .foot { display: flex; align-items: center; gap: 12px; min-height: 18px; }
  #ns-nudge .msg { opacity: .85; letter-spacing: 0.06em; }
  #ns-nudge .msg.err { opacity: .55; }
  #ns-nudge .skip { margin-left: auto; background: none; border: 0; color: inherit; font: inherit; opacity: .4; cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 3px; }
  #ns-nudge .skip:hover { opacity: .8; }
  `;

  let el = null;
  let tool = "";

  function snooze() { set(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); }

  function close(snoozeIt) {
    if (!el) return;
    if (snoozeIt) snooze();
    const node = el;
    el = null;
    node.classList.remove("in");
    setTimeout(() => node.remove(), 400);
    window.removeEventListener("keydown", onKey, true);
  }

  function onKey(e) {
    if (e.key !== "Escape" || !el) return;
    e.stopPropagation(); // the tools bind Esc too — this one's ours while open
    close(true);
  }

  function show() {
    if (el) return;
    if (!document.getElementById("ns-nudge-css")) {
      const s = document.createElement("style");
      s.id = "ns-nudge-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    el = document.createElement("form");
    el.id = "ns-nudge";
    el.noValidate = true;
    el.innerHTML = `
      <div class="bar"><span class="idx">//</span><span class="title">subscribe</span><button type="button" class="x" aria-label="close">×</button></div>
      <div class="body">
        <p class="hp" aria-hidden="true"><label>leave this empty: <input name="bot-field" tabindex="-1" autocomplete="off"></label></p>
        <label class="lbl" for="ns-nudge-email">your file's on its way. new tools + releases land in the inbox first — leave an email and we'll send one sometimes</label>
        <div class="row">
          <input id="ns-nudge-email" type="email" name="email" required placeholder="you@…" spellcheck="false" autocomplete="email">
          <button type="submit" class="go">join list</button>
        </div>
        <div class="foot"><span class="msg" hidden></span><button type="button" class="skip">no thanks</button></div>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el && el.classList.add("in"));

    const form = el;
    const input = form.querySelector("input[type=email]");
    const msg = form.querySelector(".msg");
    const go = form.querySelector(".go");
    const say = (t, err) => { msg.hidden = false; msg.textContent = t; msg.classList.toggle("err", !!err); };

    form.querySelector(".x").addEventListener("click", () => close(true));
    form.querySelector(".skip").addEventListener("click", () => close(true));
    window.addEventListener("keydown", onKey, true);
    // the tools bind single-letter keys — typing an email mustn't play them
    form.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input.checkValidity()) {
        say(input.value.trim() ? "that doesn't look like an email" : "an email goes here first", true);
        input.focus();
        return;
      }
      go.disabled = true;
      msg.hidden = true;
      const email = input.value.trim();
      try {
        const res = await fetch("/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, source: "tools", tool, "bot-field": form.querySelector('[name="bot-field"]').value }),
        });
        if (!res.ok) throw new Error(String(res.status));
        set(EMAIL_KEY, email);
        form.querySelector(".skip").hidden = true;
        say("signal received — you're on the list");
        setTimeout(() => { if (el === form) close(false); }, 2600);
      } catch (_) {
        go.disabled = false;
        say("transmission failed — try again", true);
      }
    });
  }

  // call right after a tool's download fires
  function afterExport(name) {
    tool = String(name || "");
    const n = (parseInt(get(COUNT_KEY), 10) || 0) + 1;
    set(COUNT_KEY, String(n));
    if (get(EMAIL_KEY)) return;
    if (n < FIRST_AT) return;
    if (Date.now() < (parseInt(get(SNOOZE_KEY), 10) || 0)) return;
    setTimeout(show, DELAY_MS);
  }

  window.NewspeechGate = { afterExport, show };
})();
