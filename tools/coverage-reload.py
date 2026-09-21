#!/usr/bin/env python3
"""Reload coverage-defa33-copy.md (source of truth for the words) into coverage-defa33.html.

Copydoc grammar (see the ground rules at the top of the copydoc):
  ## heading                 -> a <section> (id from SECTION_IDS), dot-rail entry
  - **field:** value         -> named field (h2, note, meta/hero strings)
  ### <name> table           -> <table> of `label — text` rows (h3 if <name> is >1 word)
  - [text](url) ...          -> <ul class="links"> list
  any other line             -> <p>
Inline: **bold** -> <strong>, *em* -> <em>, [t](u) -> <a>.
Only the region between </header> and <footer>, the hero strings, the <title>/og
and the #toc are rewritten; CSS + JS in the HTML are left alone.
"""
import re, html, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
MD = ROOT / "coverage-defa33-copy.md"
HTML = ROOT / "coverage-defa33.html"

SECTION_IDS = {
    "premise": "premise", "the statement": "statement", "the parts": "parts",
    "the schedule": "schedule", "the days": "days", "what the air does": "air",
    "why radio": "radio", "the library": "library", "the broadcast": "broadcast",
    "the instrument": "instrument", "generation zero": "zero", "lineage": "lineage",
    "rig": "rig", "outputs": "outputs", "newspeech": "newspeech",
}

def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])", r"<em>\1</em>", s)
    return s

def parse(md):
    secs, cur = [], None
    for line in md.split("\n"):
        if line.startswith("## "):
            cur = {"title": line[3:].strip(), "fields": {}, "blocks": []}
            secs.append(cur); continue
        if cur is None: continue
        if line.startswith("### "):
            cur["blocks"].append({"kind": "table", "name": line[4:].strip(), "rows": []}); continue
        m = re.match(r"- \*\*(.+?):\*\*\s*(.*)", line)
        if m:
            cur["fields"][m.group(1).strip()] = m.group(2).strip(); continue
        if line.startswith("- ") and cur["blocks"] and cur["blocks"][-1]["kind"] == "table" and " — " in line:
            lab, txt = line[2:].split(" — ", 1)
            cur["blocks"][-1]["rows"].append((lab.strip(), txt.strip())); continue
        if line.startswith("- ["):
            if not cur["blocks"] or cur["blocks"][-1]["kind"] != "links":
                cur["blocks"].append({"kind": "links", "items": []})
            cur["blocks"][-1]["items"].append(line[2:].strip()); continue
        if line.strip():
            cur["blocks"].append({"kind": "p", "text": line.strip()})
    return secs

def render_blocks(blocks, pcls=""):
    out = []
    for b in blocks:
        if b["kind"] == "p":
            out.append(f"  <p{pcls}>{inline(b['text'])}</p>")
        elif b["kind"] == "table":
            name = re.sub(r"\s+table$", "", b["name"])
            if len(name.split()) > 1:
                out.append(f"  <h3>{inline(name)}</h3>")
            rows = "\n".join(f"        <tr><td>{inline(l)}</td><td>{inline(t)}</td></tr>" for l, t in b["rows"])
            out.append("  <div class=\"tbl-scroll\">\n    <table>\n      <tbody>\n" + rows + "\n      </tbody>\n    </table>\n  </div>")
        elif b["kind"] == "links":
            items = "\n".join(f"    <li>{inline(i)}</li>" for i in b["items"])
            out.append("  <ul class=\"links\">\n" + items + "\n  </ul>")
    return "\n".join(out)

def main():
    md = MD.read_text(); page = HTML.read_text()
    secs = {s["title"]: s for s in parse(md)}
    meta = secs["meta"]["fields"]

    body, toc = [], ['  <a href="#top"><span class="dot"></span><span class="lbl">top</span></a>']
    cap = next((s for t, s in secs.items() if t.startswith("figure caption")), None)
    if cap:
        body.append('<section class="wide">\n  <figure>\n    <canvas id="fig-wear" height="360"></canvas>\n'
                    f'    <figcaption>{inline(cap["blocks"][0]["text"])}</figcaption>\n  </figure>\n</section>')
    first = True
    for title, sec in secs.items():
        if title not in SECTION_IDS: continue
        sid = SECTION_IDS[title]
        cls = "col" if first else "col rule"; first = False
        h2 = sec["fields"].get("h2", title)
        parts = [f'<section class="{cls}" id="{sid}">', f"  <h2>{inline(h2)}</h2>"]
        if sid == "statement":
            parts.append('  <div class="statement">')
            parts.append(render_blocks([b for b in sec["blocks"] if b["kind"] == "p"]))
            parts.append("  </div>")
            if "note" in sec["fields"]:
                parts.append(f'  <p class="note">{inline(sec["fields"]["note"])}</p>')
        else:
            parts.append(render_blocks(sec["blocks"]))
        parts.append("</section>")
        body.append("\n".join(parts))
        toc.append(f'  <a href="#{sid}"><span class="dot"></span><span class="lbl">{inline(title)}</span></a>')

    page = re.sub(r"(</header>\n)(.*?)(\n<footer class=\"col\">)", lambda m: m.group(1) + "\n" + "\n\n".join(body) + "\n" + m.group(3), page, flags=re.S)
    page = re.sub(r'(<nav id="toc" aria-label="sections">\n).*?(\n</nav>)', lambda m: m.group(1) + "\n".join(toc) + m.group(2), page, flags=re.S)
    footer = secs["footer"]["blocks"][0]["text"]
    page = re.sub(r'(<footer class="col">\n).*?(\n</footer>)', lambda m: m.group(1) + "  " + inline(footer) + m.group(2), page, flags=re.S)

    # hero + head strings
    t = meta["page title"]
    page = re.sub(r"<title>.*?</title>", f"<title>{html.escape(t)}</title>", page)
    page = re.sub(r'(og:title" content=")[^"]*', lambda m: m.group(1) + "NEWSPEECH // " + html.escape(meta["title (h1)"]), page)
    page = re.sub(r'(og:description" content=")[^"]*', lambda m: m.group(1) + html.escape(meta["og description"]), page)
    page = re.sub(r'<h1 aria-label="[^"]*">[^<]*</h1>', f'<h1 aria-label="{html.escape(meta["title (h1)"])}">{html.escape(meta["title (h1)"])}</h1>', page)
    page = re.sub(r'(<div class="hero-gen" id="hero-gen">)[^<]*', lambda m: m.group(1) + html.escape(meta["readout (under the title)"]), page)
    page = re.sub(r'(<p class="dek">)[^<]*', lambda m: m.group(1) + html.escape(meta["dek (bottom left)"]), page)
    page = re.sub(r'(<span class="hero-right">)[^<]*', lambda m: m.group(1) + html.escape(meta["hero right"]), page)
    page = re.sub(r'(<div class="osd">\n    <span>)[^<]*(</span>\n    <span>)[^<]*',
                  lambda m: m.group(1) + html.escape(meta["osd left (top of screen)"]) + m.group(2) + html.escape(meta["osd right"]), page)
    HTML.write_text(page)
    print(f"reloaded {len(body)} blocks into {HTML.name}")

if __name__ == "__main__":
    main()
