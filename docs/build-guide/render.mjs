// Joins the three parts and prints them to docs/conclave-build-guide.pdf.
// Run from the repository root: node docs/build-guide/render.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const html = ["part1.html", "part2.html", "part3.html"].map((f) => readFileSync(resolve(here, f), "utf8")).join("\n");
const joined = resolve(here, "conclave-build-guide.html");
writeFileSync(joined, html);

const channel = process.env.PW_CHANNEL === undefined ? "msedge" : process.env.PW_CHANNEL || undefined;
const browser = await chromium.launch(channel ? { channel } : {});
const page = await browser.newPage();
await page.goto(pathToFileURL(joined).href);
const out = resolve(here, "..", "conclave-build-guide.pdf");
await page.pdf({
  path: out,
  format: "A4",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate:
    '<div style="width:100%;font-family:Segoe UI,sans-serif;font-size:7.5pt;color:#5c5f66;padding:0 16mm;display:flex;justify-content:space-between"><span>Conclave build guide</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
});
await browser.close();
console.log(out);
