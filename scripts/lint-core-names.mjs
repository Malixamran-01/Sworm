#!/usr/bin/env node
// MOD-001: core code never names a specific outside product. Products live in modules.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CORE_DIRS = ["packages/contract/src", "packages/db/src", "packages/engine/src", "packages/core/src"];
const PRODUCTS = ["anthropic", "claude", "openai", "gpt-", "gemini", "ollama", "hermes", "openclaw", "n8n", "obsidian", "home assistant", "notion", "telegram", "slack", "discord"];
const pattern = new RegExp(`\\b(${PRODUCTS.map((p) => p.replace(/[-\s]/g, (c) => (c === " " ? "\\s" : "-"))).join("|")})`, "i");

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) && !name.startsWith("test-")) files.push(path);
  }
};
CORE_DIRS.forEach(walk);

const hits = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (pattern.test(line)) hits.push(`${relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
    });
}

if (hits.length) {
  console.error(`Core code names an outside product (MOD-001). Move it into a module:\n${hits.join("\n")}`);
  process.exit(1);
}
console.log(`MOD-001 ok: ${files.length} core files name no outside product.`);
