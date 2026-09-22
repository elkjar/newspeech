// Render the one-page release plan to PDF (letter).
// Uses the Playwright already installed under tools/reel-render.
//   node tools/release-plan/render.mjs
// The stylesheet is rem-based; this script finds the largest html font-size
// at which the .page content still fits one sheet, so the layout fills it.
import { chromium } from "../reel-render/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(here, "night-school-release-plan.html");
const pdf = path.join(here, "night-school-release-plan.pdf");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
await page.goto("file://" + html);
await page.evaluate(() => document.fonts.ready);

const fits = (px) => page.evaluate((px) => {
  document.documentElement.style.fontSize = px + "px";
  const el = document.querySelector(".page");
  return el.scrollHeight <= el.clientHeight;
}, px);

let lo = 8, hi = 20;                 // px; bisect to 0.05px
while (hi - lo > 0.05) { const mid = (lo + hi) / 2; (await fits(mid)) ? (lo = mid) : (hi = mid); }
const size = Math.floor(lo * 20) / 20 - 0.1;  // step back slightly for slack
await fits(size);
console.log("html font-size", size.toFixed(2) + "px");

await page.pdf({ path: pdf, format: "Letter", printBackground: true, preferCSSPageSize: true });
await browser.close();
console.log("wrote", pdf);
