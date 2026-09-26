// md.mjs — the site's markdown subset, shared by build-news.mjs (posts) and
// build-shop.mjs (product descriptions). inline: `code` / **bold** / *em* /
// [links](…). blocks: headings, hr, blockquote, lists, fenced code, a lone
// image → figure, raw-HTML passthrough (a block opening with <, until the next
// blank line), and a paragraph that is exactly one link → a CTA button.

export const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function figureHtml(src, alt, caption, cls) {
  return `<figure${cls ? ` class="${cls}"` : ""}><img src="${src}" alt="${esc(alt)}" loading="lazy">${
    caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}</figure>`;
}

// inline spans: text is escaped first, then `code` / **bold** / *em* / links.
export function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) => {
    const ext = /^https?:\/\//.test(href);
    return `<a href="${href}"${ext ? ` target="_blank" rel="noopener noreferrer"` : ""}>${txt}</a>`;
  });
  return s;
}

// block-level markdown → HTML. raw HTML blocks (a line opening with <) pass
// through verbatim until the next blank line — that's the audio/video/iframe
// escape hatch.
export function mdToHtml(md) {
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  const collect = (pred) => {
    const got = [];
    while (i < lines.length && pred(lines[i])) got.push(lines[i++]);
    return got;
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }

    if (t.startsWith("```")) {                               // fenced code
      i++;
      const code = collect((l) => !l.trim().startsWith("```"));
      i++; // closing fence
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (t.startsWith("<")) {                          // raw HTML passthrough
      out.push(collect((l) => l.trim() !== "").join("\n"));
    } else if (/^#{1,4} /.test(t)) {                         // headings
      const level = t.match(/^#+/)[0].length;
      out.push(`<h${level}>${inline(t.replace(/^#+ /, ""))}</h${level}>`);
      i++;
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {                 // hr
      out.push("<hr>");
      i++;
    } else if (t.startsWith("> ")) {                         // blockquote
      const quote = collect((l) => l.trim().startsWith(">"));
      out.push(`<blockquote>${quote.map((l) => inline(l.trim().replace(/^>\s?/, ""))).join("<br>")}</blockquote>`);
    } else if (/^[-*] /.test(t)) {                           // unordered list
      const items = collect((l) => /^[-*] /.test(l.trim()));
      out.push(`<ul>${items.map((l) => `<li>${inline(l.trim().slice(2))}</li>`).join("")}</ul>`);
    } else if (/^\d+\. /.test(t)) {                          // ordered list
      const items = collect((l) => /^\d+\. /.test(l.trim()));
      out.push(`<ol>${items.map((l) => `<li>${inline(l.trim().replace(/^\d+\. /, ""))}</li>`).join("")}</ol>`);
    } else if (/^!\[/.test(t)) {                             // image on its own line → figure
      const m = t.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
      if (m) { out.push(figureHtml(m[2], m[1], m[3], "")); i++; }
      else { out.push(`<p>${inline(t)}</p>`); i++; }
    } else {                                                 // paragraph
      const para = collect((l) => {
        const s = l.trim();
        return s !== "" && !/^(#{1,4} |```|> |[-*] |\d+\. |<|!\[)/.test(s);
      });
      // a paragraph that is exactly one link → button-style call to action
      // (the "try slice" links under each tool section); no new syntax.
      const cta = para.length === 1 && /^\[[^\]]+\]\([^)\s]+\)$/.test(para[0].trim());
      out.push(`<p${cta ? ' class="cta"' : ""}>${para.map((l) => inline(l.trim())).join("<br>")}</p>`);
    }
  }
  return out.join("\n");
}
