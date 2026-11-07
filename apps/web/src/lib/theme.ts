import { useSyncExternalStore } from "react";

/** Light is the reference theme from the mockups; dark and system are opt-in. */
export type ThemeChoice = "light" | "dark" | "system";
const KEY = "conclave.theme";
const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

let choice: ThemeChoice = read();

function apply() {
  const dark = choice === "dark" || (choice === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

apply();
media.addEventListener("change", apply);

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage can be blocked; the choice still applies for this visit */
  }
  apply();
  for (const l of listeners) l();
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => choice,
  );
}
