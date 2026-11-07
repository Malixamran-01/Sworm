/** Letter-tile colours from the mockups, as CSS variable pairs that follow the theme. */
export const tilePalettes = ["blue", "green", "teal", "amber", "violet", "peach", "mint", "sky", "grey"] as const;
export type TilePalette = (typeof tilePalettes)[number];

export const tileColors = (p: TilePalette) => ({ background: `var(--tile-${p}-bg)`, color: `var(--tile-${p}-fg)` });

/** A stable colour for any id, so a workspace keeps its colour everywhere. */
export function paletteFor(id: string): TilePalette {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return tilePalettes[h % (tilePalettes.length - 1)]!;
}

export const initials = (name: string, max = 2): string => {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (max === 1 || words.length === 1) return words[0]!.slice(0, max === 1 ? 1 : 2).replace(/^./, (c) => c.toUpperCase());
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
};

/**
 * How a module looks in the UI. Modules may declare nodeUi in their manifest;
 * this table covers the reference modules until the manifest colour is wired through.
 */
const MODULE_LOOK: Record<string, { short: string; palette: TilePalette }> = {
  "conclave/anthropic": { short: "Cl", palette: "peach" },
  "conclave/openai-compatible": { short: "AI", palette: "mint" },
  "conclave/mock-model": { short: "Mk", palette: "grey" },
};

export function moduleLook(moduleId: string, name: string): { short: string; palette: TilePalette } {
  return MODULE_LOOK[moduleId] ?? { short: initials(name), palette: paletteFor(moduleId) };
}

/** What kind of connection a port means, for grouping (SRS 4.11). */
export const PORT_GROUPS: Record<string, string> = {
  model: "Language models",
  agent: "Agents",
  workflow: "Workflow engines",
  tool: "Tools",
  knowledge: "Knowledge",
  trigger: "Triggers",
  channel: "Channels",
  device: "Devices",
  storage: "Storage",
  media: "Image, video & voice",
};
