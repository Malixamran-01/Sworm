import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { setTheme } from "../lib/theme";
import { cx } from "../ui";
import { SearchIcon } from "../ui/icons";

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

/** Every action reachable from ⌘K / Ctrl+K (SRS 7.6). */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces, enabled: open });
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => void navigate({ to });
    const list: Command[] = [
      { id: "home", label: "Home", hint: "Go to", run: go("/") },
      { id: "inbox", label: "Inbox", hint: "Go to", run: go("/inbox") },
      { id: "connections", label: "Connections", hint: "Go to", run: go("/connections") },
      { id: "insights", label: "Insights: spend, reliability and audit trail", hint: "Go to", run: go("/insights") },
      { id: "new-ws", label: "Create a workspace", hint: "Action", run: go("/workspaces/new") },
      { id: "add-conn", label: "Add a connection", hint: "Action", run: go("/connections") },
      { id: "light", label: "Use light theme", hint: "Theme", run: () => setTheme("light") },
      { id: "dark", label: "Use dark theme", hint: "Theme", run: () => setTheme("dark") },
      { id: "system", label: "Match system theme", hint: "Theme", run: () => setTheme("system") },
    ];
    for (const w of workspaces.data ?? []) {
      list.push({ id: `ws-${w.id}`, label: w.name, hint: "Workspace", run: go(`/workspaces/${w.id}`) });
      list.push({ id: `team-${w.id}`, label: `${w.name}: Team`, hint: "Workspace", run: go(`/workspaces/${w.id}/team`) });
    }
    return list;
  }, [workspaces.data, navigate]);

  const results = commands.filter((c) => c.label.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;
  const choose = (c: Command | undefined) => {
    if (!c) return;
    c.run();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-4 text-muted">
          <SearchIcon />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                choose(results[index]);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            placeholder="Search or run a command"
            aria-label="Search or run a command"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-autocomplete="list"
            aria-controls="palette-results"
            aria-activedescendant={results[index] ? `cmd-${results[index].id}` : undefined}
            className="h-12 flex-1 border-0 bg-transparent text-[15px] text-ink outline-none"
          />
        </div>
        <ul id="palette-results" role="listbox" aria-label="Commands" tabIndex={-1} className="m-0 max-h-[min(360px,55vh)] list-none overflow-y-auto overscroll-contain p-1.5">
          {results.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(c)}
              className={cx("flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm", i === index && "bg-accent-soft text-accent-ink")}
            >
              <span>{c.label}</span>
              <span className="text-xs text-muted">{c.hint}</span>
            </li>
          ))}
          {results.length === 0 ? <li className="px-3 py-4 text-sm text-muted">Nothing matches.</li> : null}
        </ul>
      </div>
    </div>
  );
}
