// footer.js — the site footer. loaded by nav.js, so every page with the nav
// gets it: the wordmark + a mailing-list box, the whole site as link lists,
// and a small print row (licenses, source, back to top).
//
// pages put their body in different containers (the tool pages are a 1060
// body with side padding, the rest run full width), so the footer breaks out
// to the viewport and lays its content on the nav's column (1280 container,
// --ns-gutter inside). it also eats the body's bottom padding so it sits on
// the page's floor. a page whose last section ends on its own 1px rule sets
// --ns-foot-gap: 0px and --ns-foot-rule: 0 so the lines don't double.
(function () {
  "use strict";
  if (document.getElementById("ns-foot")) return; // idempotent

  const src = (document.currentScript && document.currentScript.getAttribute("src")) || "footer.js";
  const ROOT = src.slice(0, src.lastIndexOf("footer.js"));

  const EXT = ' target="_blank" rel="noopener noreferrer"';
  // [heading, heading link, links]
  const COLS = [
    ["tools", "tools.html", [
      ["texture", "texture.html"], ["slice", "slice.html"], ["decay", "decay.html"],
      ["drone", "drone.html"], ["glitch", "glitch.html"], ["stretch", "stretch.html"],
      ["samples", "samples.html"], ["visuals", "visualizers.html"],
    ]],
    ["plugins", "plugins.html", [
      ["vibe", "plugins.html#vibe"], ["saturate", "plugins.html#saturate"],
      ["slice", "plugins.html#slice"], ["glitch", "plugins.html#glitch"],
    ]],
    ["site", null, [
      ["news", "news.html"], ["about", "about.html"], ["sequence", "index.html#v-sequence"], ["rss", "feed.xml"],
    ]],
    ["follow", null, [
      ["instagram", "https://www.instagram.com/newspeechsound"],
      ["youtube", "https://www.youtube.com/@newspeechsound"],
      ["discord", "https://discord.gg/GgGSXK3WT"],
    ]],
  ];
  const href = (u) => /^https?:/.test(u) ? `href="${u}"${EXT}` : `href="${ROOT}${u}"`;

  const css = `
  #ns-foot {
    /* break out of whatever container the page's body is: the viewport's
       content width (no scrollbar), centered on the body's center */
    --ns-vw: calc(100vw - var(--ns-sbw, 0px));
    width: var(--ns-vw);
    /* pages whose last section already draws a bottom rule zero these */
    margin: var(--ns-foot-gap, 120px) 0 0 calc(50% - var(--ns-vw) / 2);
    border-top: var(--ns-foot-rule, 1px solid rgba(255, 255, 255, 0.18));
    background: #050505;
    color: #fff;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.6;
    letter-spacing: 0.02em;
    text-align: left;
  }
  #ns-foot .nf-in {
    max-width: 1280px;
    margin: 0 auto;
    padding: 56px var(--ns-gutter, 40px) 28px;
  }
  #ns-foot a { color: inherit; text-decoration: none; }
  /* desktop: the brand takes the slack on the left; the four link columns
     hug their content as one cluster against the right edge */
  #ns-foot .nf-top {
    display: grid;
    grid-template-columns: minmax(0, 1fr) repeat(4, minmax(110px, max-content));
    column-gap: 56px;
    row-gap: 40px;
  }
  #ns-foot .nf-brand { padding-right: 24px; }
  #ns-foot .nf-mark img { display: block; height: 22px; width: auto; max-width: 100%; }
  #ns-foot .nf-tag { margin: 14px 0 0; color: rgba(255, 255, 255, 0.45); }
  #ns-foot form { margin-top: 36px; max-width: 360px; }
  #ns-foot .nf-label { display: block; color: rgba(255, 255, 255, 0.6); margin-bottom: 10px; }
  #ns-foot .nf-row { display: flex; gap: 8px; }
  #ns-foot .nf-row input {
    flex: 1 1 0;
    min-width: 0;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.45);
    border-radius: 0;
    color: #fff;
    font: inherit;
    line-height: 18px; /* the site's sign-up spec — 34px tall, see index.html */
    letter-spacing: 0.04em;
    padding: 7px 12px;
    outline: none;
  }
  #ns-foot .nf-row input:focus { border-color: rgba(255, 255, 255, 0.9); }
  #ns-foot .nf-row input::placeholder { color: rgba(255, 255, 255, 0.3); }
  #ns-foot .nf-row button {
    flex: none;
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.7);
    color: #fff;
    font: inherit;
    line-height: 18px;
    letter-spacing: 0.04em;
    padding: 7px 16px;
    cursor: pointer;
  }
  #ns-foot .nf-row button:hover { background: rgba(255, 255, 255, 0.08); }
  #ns-foot .nf-row button:disabled { opacity: 0.4; cursor: default; }
  #ns-foot .nf-hp { display: none; }
  #ns-foot .nf-msg { display: block; margin-top: 10px; color: rgba(255, 255, 255, 0.7); }
  #ns-foot .nf-msg.err { color: rgba(255, 255, 255, 0.45); }
  #ns-foot h4 {
    margin: 0 0 14px;
    font-size: 11px;
    font-weight: normal;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.4);
  }
  #ns-foot h4 a:hover { color: #fff; }
  #ns-foot ul { list-style: none; margin: 0; padding: 0; }
  #ns-foot li + li { margin-top: 6px; }
  #ns-foot li a { color: rgba(255, 255, 255, 0.65); transition: color 120ms ease; }
  #ns-foot li a:hover { color: #fff; }
  #ns-foot .nf-base {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px 28px;
    margin-top: 56px;
    padding-top: 20px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: rgba(255, 255, 255, 0.4);
  }
  #ns-foot .nf-base a { border-bottom: 1px solid rgba(255, 255, 255, 0.2); }
  #ns-foot .nf-base a:hover { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.7); }
  #ns-foot .nf-top-link { margin-left: auto; border-bottom: 0 !important; }
  /* narrower: the brand gets its own row, the four columns sit under it */
  @media (max-width: 1100px) {
    #ns-foot .nf-top { grid-template-columns: repeat(4, minmax(110px, max-content)); }
    #ns-foot .nf-brand { grid-column: 1 / -1; padding-right: 0; }
  }
  @media (max-width: 640px) {
    #ns-foot .nf-top { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 40px 24px; }
    #ns-foot .nf-row input { font-size: 16px; } /* <16px zooms iOS Safari on focus */
  }`;

  function build() {
    if (document.getElementById("ns-foot")) return;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const foot = document.createElement("footer");
    foot.id = "ns-foot";
    foot.innerHTML =
      `<div class="nf-in"><div class="nf-top">` +
      `<div class="nf-brand">` +
      `<a class="nf-mark" href="${ROOT}index.html" aria-label="newspeech"><img src="${ROOT}assets/ns-text.svg" alt="" draggable="false"></a>` +
      `<p class="nf-tag">audio/video experimentation</p>` +
      `<form novalidate>` +
      `<label class="nf-label" for="nf-email">releases + new tools, when they land</label>` +
      `<p class="nf-hp" aria-hidden="true"><label>leave this empty: <input name="bot-field" tabindex="-1" autocomplete="off"></label></p>` +
      `<div class="nf-row"><input id="nf-email" type="email" name="email" required placeholder="you@…" spellcheck="false" autocomplete="email">` +
      `<button type="submit">join list</button></div>` +
      `</form></div>` +
      COLS.map(([h, hl, links]) =>
        `<nav aria-label="${h}"><h4>${hl ? `<a ${href(hl)}>${h} →</a>` : h}</h4><ul>` +
        links.map(([t, u]) => `<li><a ${href(u)}>${t}</a></li>`).join("") +
        `</ul></nav>`
      ).join("") +
      `</div>` +
      `<div class="nf-base">` +
      `<span>© ${new Date().getFullYear()} newspeech</span>` +
      `<span>samples cc by-sa 4.0 · code gplv3 · <a href="https://github.com/elkjar/newspeech"${EXT}>source</a></span>` +
      `<a class="nf-top-link" href="#">top ↑</a>` +
      `</div></div>`;
    document.body.appendChild(foot);

    // the scrollbar's width, so the breakout is exactly the visible viewport
    // (100vw counts the scrollbar — it would overflow sideways)
    const syncSbw = () => document.documentElement.style.setProperty(
      "--ns-sbw", (window.innerWidth - document.documentElement.clientWidth) + "px");
    syncSbw();
    window.addEventListener("resize", syncSbw);
    // sit on the page floor: cancel the body's bottom padding under the footer
    const pb = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
    if (pb) foot.style.marginBottom = `-${pb}px`;
    // on a page shorter than the screen (a min-height body with little in
    // it) push the footer down to the bottom instead of leaving a gap under it
    function settle() {
      foot.style.marginTop = "";
      const under = document.documentElement.scrollHeight - (foot.getBoundingClientRect().bottom + window.scrollY);
      if (under > 1) foot.style.marginTop = `calc(var(--ns-foot-gap, 120px) + ${Math.floor(under)}px)`;
    }
    settle();
    new ResizeObserver(settle).observe(document.body);
    window.addEventListener("resize", settle);

    foot.querySelector(".nf-top-link").addEventListener("click", (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    // mailing list: the site's one door, source "footer"; a known email
    // (any newspeech form) is prefilled
    const form = foot.querySelector("form");
    const input = form.querySelector('input[type="email"]');
    try { input.value = localStorage.getItem("newspeech.email") || ""; } catch (_) {}
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      form.querySelector(".nf-msg")?.remove();
      if (!input.checkValidity()) { input.focus(); return; }
      const btn = form.querySelector("button");
      btn.disabled = true;
      try {
        const res = await fetch("/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: input.value.trim(),
            source: "footer",
            "bot-field": form.querySelector('[name="bot-field"]').value,
          }),
        });
        if (!res.ok) throw new Error(String(res.status));
        try { localStorage.setItem("newspeech.email", input.value.trim()); } catch (_) {}
        form.querySelector(".nf-row").remove();
        const msg = document.createElement("span");
        msg.className = "nf-msg";
        msg.textContent = "signal received — you're on the list";
        form.appendChild(msg);
      } catch (_) {
        btn.disabled = false;
        const msg = document.createElement("span");
        msg.className = "nf-msg err";
        msg.textContent = "transmission failed — try again";
        form.appendChild(msg);
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
