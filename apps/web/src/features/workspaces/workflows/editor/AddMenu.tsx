import type { StepKind } from "@conclave/contract";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, cx, Tile } from "../../../../ui";
import { KIND_LOOK } from "./graph";

const GROUPS: { name: string; kinds: StepKind[] }[] = [
  { name: "Work", kinds: ["role", "tool", "lookup", "agent", "automation", "workspace", "text"] },
  { name: "Logic", kinds: ["branch", "classify", "merge", "stop"] },
  { name: "People", kinds: ["approval"] },
];

interface Place {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/**
 * Where the popover goes: under the button, or above it when there is more
 * room there, never past a window edge, and never taller than the room left.
 */
function placeFor(button: HTMLElement): Place {
  const r = button.getBoundingClientRect();
  const gap = 6;
  const edge = 12;
  const width = Math.min(480, window.innerWidth - edge * 2);
  const left = Math.min(Math.max(r.right - width, edge), window.innerWidth - width - edge);
  const below = window.innerHeight - r.bottom - gap - edge;
  const above = r.top - gap - edge;
  if (below < 300 && above > below) return { left, width, bottom: window.innerHeight - r.top + gap, maxHeight: above };
  return { left, width, top: r.bottom + gap, maxHeight: below };
}

/**
 * The Add menu (WF-007): every kind of step, grouped, with a search box. It
 * fits the window and scrolls inside itself; arrow keys move between items.
 */
export function AddMenu({ onAdd, onNote, after }: { onAdd: (k: StepKind) => void; onNote: () => void; after: string | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [place, setPlace] = useState<Place | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const close = (refocus = true) => {
    setOpen(false);
    setPlace(null);
    setQuery("");
    if (refocus) trigger.current?.focus();
  };

  // Place it when it opens, and again when the window changes size or scrolls.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const update = () => trigger.current && setPlace(placeFor(trigger.current));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  // Focus the search box once the panel is drawn.
  const placed = !!place;
  useEffect(() => {
    if (open && placed) search.current?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && close(false);
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  });

  const q = query.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({
    ...g,
    kinds: g.kinds.filter((k) => !q || `${KIND_LOOK[k].label} ${KIND_LOOK[k].help} ${g.name}`.toLowerCase().includes(q)),
  })).filter((g) => g.kinds.length);
  const first = groups[0]?.kinds[0];
  const pick = (k: StepKind) => {
    onAdd(k);
    close();
  };

  // Arrow keys move through the items; Escape closes and goes back to the button.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>("[data-add-item]") ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
    items[next]!.focus();
  };

  return (
    <div ref={wrap}>
      <Button ref={trigger} size="sm" variant="primary" aria-expanded={open} aria-controls="add-step-menu" onClick={() => (open ? close(false) : setOpen(true))}>
        + Add
      </Button>
      {open && place ? (
        <div
          ref={panel}
          id="add-step-menu"
          role="dialog"
          aria-label="Add a step"
          onKeyDown={onKeyDown}
          className="fixed z-50 flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-xl"
          style={{ left: place.left, width: place.width, maxHeight: place.maxHeight, ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }) }}
        >
          <div className="flex flex-col gap-1 border-b border-line p-2.5">
            <input
              ref={search}
              type="search"
              aria-label="Search steps"
              placeholder="Search steps"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && first) {
                  e.preventDefault();
                  pick(first);
                }
              }}
              className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted"
            />
            <p className="m-0 px-0.5 text-xs text-muted">{after ? `Adds after ${after}, connected.` : "Select a step first to add after it, connected."}</p>
          </div>

          {/* The list scrolls on its own, so the menu never runs past the window. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {groups.length === 0 ? <p className="m-0 p-3 text-center text-[13px] text-muted">No step matches “{query}”.</p> : null}
            {groups.map((g) => (
              <section key={g.name} aria-label={g.name} className="mb-1.5 last:mb-0">
                <h3 className="m-0 px-1.5 pt-1 pb-1 text-[11px] font-bold tracking-wide text-muted uppercase">{g.name}</h3>
                <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                  {g.kinds.map((k) => (
                    <button
                      key={k}
                      type="button"
                      data-add-item
                      onClick={() => pick(k)}
                      className={cx(
                        "flex items-start gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-sunken focus-visible:bg-sunken",
                        k === first && q && "bg-sunken",
                      )}
                    >
                      <Tile text={KIND_LOOK[k].short} palette={KIND_LOOK[k].palette} size={30} />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-[13px] font-semibold">{KIND_LOOK[k].label}</span>
                        <span className="line-clamp-2 text-xs leading-snug text-muted">{KIND_LOOK[k].help}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="border-t border-line p-1.5">
            <button
              type="button"
              data-add-item
              onClick={() => {
                onNote();
                close();
              }}
              className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-[13px] font-semibold hover:bg-sunken focus-visible:bg-sunken"
            >
              <Tile text="✎" palette="amber" size={22} />
              Sticky note
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
