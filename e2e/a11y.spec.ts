import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/** UX-001: axe finds nothing at WCAG 2.2 AA on every screen, and no screen scrolls sideways. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ids = () => JSON.parse(readFileSync("e2e/.auth/ids.json", "utf8")) as { workspaceId: string; taskId: string; outsideId: string; askingTaskId: string };

async function check(page: Page, what: string) {
  // Let queries settle and fonts load so contrast is measured on the real page.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
        .slice(0, 4)
        .map((n) => `${n.target.join(" ")}${n.failureSummary ? ` — ${n.failureSummary.split("\n").slice(1, 2).join("").trim()}` : ""}`)
        .join("\n  ")}`,
  );
  expect(summary, `${what} has accessibility problems`).toEqual([]);
  // Reflow (WCAG 1.4.10): the page itself never scrolls sideways.
  const { overflow, culprits } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // The outermost elements that stick out past the right edge, skipping ones inside their own scroll area.
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      if (el.getBoundingClientRect().right <= width + 1) continue;
      let p = el.parentElement;
      let inside = false;
      while (p && p !== document.body) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden" || p.getBoundingClientRect().right > width + 1) inside = true;
        if (inside) break;
        p = p.parentElement;
      }
      if (!inside) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")} → ${Math.round(el.getBoundingClientRect().right)}px`);
    }
    return { overflow: document.documentElement.scrollWidth - width, culprits: out.slice(0, 6) };
  });
  expect(overflow, `${what} scrolls sideways: ${culprits.join("; ")}`).toBeLessThanOrEqual(1);
}

const screens: { name: string; path: () => string; then?: (page: Page) => Promise<void> }[] = [
  { name: "Home", path: () => "/" },
  { name: "Inbox", path: () => "/inbox" },
  { name: "Connections", path: () => "/connections" },
  { name: "New workspace, guided", path: () => "/workspaces/new" },
  { name: "New workspace, template", path: () => "/workspaces/new", then: (p) => p.getByRole("button", { name: "From a template" }).click() },
  { name: "New workspace, import", path: () => "/workspaces/new", then: (p) => p.getByRole("button", { name: "Import a package" }).click() },
  { name: "Workspace tasks", path: () => `/workspaces/${ids().workspaceId}` },
  { name: "Task panel", path: () => `/workspaces/${ids().workspaceId}/tasks/${ids().taskId}` },
  { name: "Trace", path: () => `/workspaces/${ids().workspaceId}/tasks/${ids().taskId}/trace` },
  {
    name: "Trace, step open",
    path: () => `/workspaces/${ids().workspaceId}/tasks/${ids().taskId}/trace`,
    then: (p) => p.getByRole("listitem").getByRole("button", { expanded: false }).nth(1).click(),
  },
  { name: "Insights", path: () => "/insights" },
  { name: "Insights, spend as a table", path: () => "/insights", then: (p) => p.getByRole("button", { name: "Show as table" }).click() },
  { name: "Insights, audit trail", path: () => "/insights", then: (p) => p.getByRole("tab", { name: "Audit trail" }).click() },
  { name: "Team", path: () => `/workspaces/${ids().workspaceId}/team` },
  { name: "Workflows", path: () => `/workspaces/${ids().workspaceId}/workflows` },
  // The node editor (WF-007): the task type panel, a selected step, and a workspace step's settings.
  { name: "Workflow editor", path: () => `/workspaces/${ids().workspaceId}/workflows/research-brief` },
  {
    name: "Workflow editor, step selected",
    path: () => `/workspaces/${ids().workspaceId}/workflows/research-brief`,
    then: (p) => p.getByRole("button", { name: "Draft Editor", exact: true }).click(),
  },
  // Branching (WF-009): the Add menu, an If / Switch with its rules, and a connector's settings.
  {
    name: "Workflow editor, add menu",
    path: () => `/workspaces/${ids().workspaceId}/workflows/new`,
    then: (p) => p.getByRole("button", { name: "+ Add" }).click(),
  },
  {
    name: "Workflow editor, If / Switch",
    path: () => `/workspaces/${ids().workspaceId}/workflows/new`,
    then: async (p) => {
      await p.getByRole("button", { name: /^Respond/ }).first().click();
      await p.getByRole("button", { name: "+ Add" }).click();
      await p.getByRole("button", { name: /^If \/ Switch/ }).click();
    },
  },
  {
    name: "Workflow editor, connector",
    path: () => `/workspaces/${ids().workspaceId}/workflows/new`,
    then: async (p) => {
      await p.getByRole("button", { name: /^Respond/ }).first().click();
      await p.getByRole("button", { name: "+ Add" }).click();
      await p.getByRole("button", { name: /^Text/ }).click();
      await p.getByRole("button", { name: /^From Respond/ }).click();
      await p.getByRole("button", { name: "Only if" }).click();
    },
  },
  {
    name: "Workflow editor, full screen with search",
    path: () => `/workspaces/${ids().workspaceId}/workflows/research-brief`,
    then: async (p) => {
      await p.getByRole("button", { name: "Full screen" }).click();
      await p.getByRole("button", { name: "+ Add" }).click();
      await p.getByRole("searchbox", { name: "Search steps" }).fill("router");
    },
  },
  // Loops (WF-010): a step that repeats until rules hold, and its settings.
  {
    name: "Workflow editor, loop",
    path: () => `/workspaces/${ids().workspaceId}/workflows/new`,
    then: async (p) => {
      await p.getByRole("button", { name: /^Respond/ }).first().click();
      await p.getByRole("button", { name: "Repeat until…" }).click();
    },
  },
  {
    name: "Workflow editor, workspace step",
    path: () => `/workspaces/${ids().workspaceId}/workflows/new`,
    then: async (p) => {
      await p.getByRole("button", { name: "+ Add" }).click();
      await p.getByRole("button", { name: /^Run a workspace/ }).click();
      await p.getByLabel("How many runs").getByRole("button", { name: "Each item" }).click();
    },
  },
  // Agent and Workflow ports (SRS 4.11): agent and automation steps, a question waiting for an answer, and Team.
  {
    name: "Workflow editor, agent step",
    path: () => `/workspaces/${ids().outsideId}/workflows/field-brief`,
    then: (p) => p.getByRole("button", { name: /^Research/ }).first().click(),
  },
  {
    name: "Workflow editor, automation step",
    path: () => `/workspaces/${ids().outsideId}/workflows/field-brief`,
    then: (p) => p.getByRole("button", { name: /^Count/ }).first().click(),
  },
  { name: "Task panel, agent asks", path: () => `/workspaces/${ids().outsideId}/tasks/${ids().askingTaskId}` },
  { name: "Team, agent roles", path: () => `/workspaces/${ids().outsideId}/team` },
  { name: "Library", path: () => `/workspaces/${ids().workspaceId}/library` },
  { name: "Activity", path: () => `/workspaces/${ids().workspaceId}/activity` },
  { name: "Workspace settings", path: () => `/workspaces/${ids().workspaceId}/settings` },
  { name: "Settings, account", path: () => "/settings" },
  { name: "Settings, security", path: () => "/settings", then: (p) => p.getByRole("button", { name: "Security" }).click() },
  { name: "Settings, notifications", path: () => "/settings", then: (p) => p.getByRole("button", { name: "Notifications" }).click() },
  { name: "Settings, members", path: () => "/settings", then: (p) => p.getByRole("button", { name: "Members" }).click() },
  { name: "Settings, single sign-on", path: () => "/settings", then: (p) => p.getByRole("button", { name: "Single sign-on" }).click() },
  { name: "Settings, tokens", path: () => "/settings", then: (p) => p.getByRole("button", { name: "Access tokens" }).click() },
  { name: "Settings, devices", path: () => "/settings", then: (p) => p.getByRole("button", { name: "Devices" }).click() },
  { name: "Command palette", path: () => "/", then: (p) => p.keyboard.press("Control+K") },
];

for (const s of screens) {
  test(s.name, async ({ page }) => {
    await page.goto(s.path());
    await expect(page.locator("main").first()).toBeVisible();
    await s.then?.(page);
    await check(page, s.name);
  });
}

test("Sign-in screen", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await check(page, "Sign-in");
  await context.close();
});
