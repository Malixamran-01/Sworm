import {
  canFail,
  describeCondition,
  portsOf,
  upstreamOf,
  wouldCycle,
  type CanvasNote,
  type NodePosition,
  type Step,
} from "@conclave/contract";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cx, Pill, Tile } from "../../../../ui";
import {
  BRIEF,
  bounds,
  CONNECTOR_LOOK,
  edgesOf,
  KIND_LOOK,
  LOOP_LOOK,
  loopLabel,
  NODE_H,
  NODE_W,
  nodeHeight,
  NOTE_W,
  PORT_ROW,
  PORT_TOP,
  resultKey,
  titleOf,
  type Draft,
  type Edge,
} from "./graph";

export type Selection =
  | { type: "step"; key: string }
  | { type: "edge"; from: string; to: string }
  | { type: "brief" }
  | { type: "loop"; key: string }
  | null;

type Gesture =
  | {
      type: "pan";
      sx: number;
      sy: number;
      vx: number;
      vy: number;
      moved: boolean;
    }
  | {
      type: "node";
      key: string;
      sx: number;
      sy: number;
      ox: number;
      oy: number;
      moved: boolean;
    }
  | {
      type: "note";
      id: string;
      sx: number;
      sy: number;
      ox: number;
      oy: number;
      moved: boolean;
    }
  | { type: "connect"; from: string; port?: string; error?: boolean; loop?: boolean };

interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.75;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** A connector's short label on the canvas, or nothing for a plain one. A named output already shows on its node. */
function edgeLabel(e: Edge): string {
  const text =
    e.label ||
    (e.type === "if" && e.when
      ? describeCondition(e.when)
      : e.type === "else"
        ? "otherwise"
        : e.type === "error"
          ? "on failure"
          : "");
  return (
    (text.length > 34 ? `${text.slice(0, 33)}…` : text) +
    (e.note ? (text ? " ✎" : "✎ note") : "")
  );
}

/**
 * The node canvas (WF-007, WF-009). Steps are nodes; a connector from A to B
 * means B may run after A. Its type decides when: always, only if rules hold,
 * otherwise, or on failure. Everything also works without dragging: the
 * panel's "Runs after" list and connector list, and arrow keys to move nodes.
 */
export function Canvas({
  draft,
  selected,
  onSelect,
  onMoveStart,
  onMove,
  onConnect,
  onDelete,
  onNotes,
  onLoop,
  describe,
  warnings,
  fitKey,
  reveal,
}: {
  draft: Draft;
  selected: Selection;
  onSelect: (s: Selection) => void;
  /** A drag or key move is about to change positions: record an undo point. */
  onMoveStart: () => void;
  onMove: (key: string, pos: NodePosition) => void;
  onConnect: (
    from: string,
    to: string,
    opts: { port?: string; type?: Edge["type"] },
  ) => void;
  onDelete: (key: string) => void;
  /** Make `from` loop back to `to`, an earlier step or itself (WF-010). */
  onLoop: (from: string, to: string) => void;
  /** Change sticky notes; `record` false while dragging. */
  onNotes: (fn: (n: CanvasNote[]) => CanvasNote[], record?: boolean) => void;
  /** One line under a node's title: its role, or what it runs. */
  describe: (s: Step) => string;
  /** Short warnings per step, such as a role with no node. */
  warnings: Map<string, string>;
  /** Change this to fit the view to the graph again. */
  fitKey: string;
  /** A step to bring into view, such as one just added. The number makes each request new. */
  reveal?: { key: string; n: number } | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 24, y: 24, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const gesture = useRef<Gesture | null>(null);
  const [linking, setLinking] = useState<{
    from: string;
    port?: string;
    error?: boolean;
    loop?: boolean;
    x: number;
    y: number;
    over: string | null;
  } | null>(null);
  const layout = draft.workflow.layout;
  const steps = draft.workflow.steps;
  const notes = draft.workflow.notes ?? [];
  const result = resultKey(draft.workflow);
  const byKey = new Map(steps.map((s) => [s.key, s]));

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - r.left - v.x) / v.k,
      y: (clientY - r.top - v.y) / v.k,
    };
  }, []);

  const nodeAt = useCallback(
    (p: { x: number; y: number }) =>
      steps.find((s) => {
        const n = layout[s.key];
        return (
          n &&
          p.x >= n.x - 12 &&
          p.x <= n.x + NODE_W + 12 &&
          p.y >= n.y - 12 &&
          p.y <= n.y + nodeHeight(s) + 12
        );
      })?.key ?? null,
    [steps, layout],
  );

  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const b = bounds(draft);
    const pad = 32;
    const k = clamp(
      Math.min(
        (el.clientWidth - pad * 2) / b.w,
        (el.clientHeight - pad * 2) / b.h,
        1,
      ),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    setView({
      k,
      x: (el.clientWidth - b.w * k) / 2 - b.x * k,
      y: (el.clientHeight - b.h * k) / 2 - b.y * k,
    });
  }, [draft]);

  // Fit when a different task type opens.
  const fitted = useRef("");
  useLayoutEffect(() => {
    if (fitted.current !== fitKey) {
      fitted.current = fitKey;
      fit();
    }
  }, [fitKey, fit]);

  // Pan just enough to show a step that is out of view.
  useEffect(() => {
    const el = box.current;
    const p = reveal ? layout[reveal.key] : undefined;
    if (!el || !p) return;
    const v = viewRef.current;
    const left = p.x * v.k + v.x;
    const top = p.y * v.k + v.y;
    const pad = 40;
    const dx =
      left < pad
        ? pad - left
        : left + NODE_W * v.k > el.clientWidth - pad
          ? el.clientWidth - pad - (left + NODE_W * v.k)
          : 0;
    const dy =
      top < pad
        ? pad - top
        : top + NODE_H * v.k > el.clientHeight - pad
          ? el.clientHeight - pad - (top + NODE_H * v.k)
          : 0;
    if (dx || dy) setView({ ...v, x: v.x + dx, y: v.y + dy });
    // Only when asked: dragging a node to the edge must not move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = box.current;
    if (!el) return;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      const px = cx ?? el.clientWidth / 2;
      const py = cy ?? el.clientHeight / 2;
      return {
        k,
        x: px - ((px - v.x) * k) / v.k,
        y: py - ((py - v.y) * k) / v.k,
      };
    });
  }, []);

  // Wheel pans; Ctrl or ⌘ with the wheel (and pinch on trackpads) zooms. Needs a non-passive listener.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest("textarea")) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAt(
          Math.exp(-e.deltaY * 0.0025),
          e.clientX - r.left,
          e.clientY - r.top,
        );
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // One set of window listeners follows whatever gesture is in progress.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (g.type === "pan") {
        const dx = e.clientX - g.sx;
        const dy = e.clientY - g.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
        setView((v) => ({ ...v, x: g.vx + dx, y: g.vy + dy }));
      } else if (g.type === "node" || g.type === "note") {
        const k = viewRef.current.k;
        const dx = (e.clientX - g.sx) / k;
        const dy = (e.clientY - g.sy) / k;
        if (!g.moved && Math.abs(dx) + Math.abs(dy) > 3 / k) {
          g.moved = true;
          if (g.type === "node") onMoveStart();
          else onNotes((n) => n, true);
        }
        if (!g.moved) return;
        if (g.type === "node") onMove(g.key, { x: g.ox + dx, y: g.oy + dy });
        else
          onNotes(
            (ns) =>
              ns.map((n) =>
                n.id === g.id
                  ? { ...n, x: Math.round(g.ox + dx), y: Math.round(g.oy + dy) }
                  : n,
              ),
            false,
          );
      } else {
        const p = toCanvas(e.clientX, e.clientY);
        const over = nodeAt(p);
        // A loop goes back to an earlier step or the same one; a connector goes forward.
        const ok = g.loop
          ? !!over && upstreamOf(draft.workflow, g.from).has(over)
          : !!over && over !== g.from && !wouldCycle(draft.workflow, g.from, over);
        setLinking({
          from: g.from,
          port: g.port,
          error: g.error,
          loop: g.loop,
          x: p.x,
          y: p.y,
          over: ok ? over : null,
        });
      }
    };
    const up = (e: PointerEvent) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g) return;
      if (g.type === "pan" && !g.moved) onSelect(null);
      if (g.type === "node" && !g.moved)
        onSelect(
          g.key === BRIEF ? { type: "brief" } : { type: "step", key: g.key },
        );
      if (g.type === "connect") {
        const to = nodeAt(toCanvas(e.clientX, e.clientY));
        setLinking(null);
        if (g.loop) {
          if (to && upstreamOf(draft.workflow, g.from).has(to)) onLoop(g.from, to);
        } else if (to && to !== g.from && !wouldCycle(draft.workflow, g.from, to)) {
          onConnect(
            g.from,
            to,
            g.error ? { type: "error" } : g.port ? { port: g.port } : {},
          );
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [
    draft.workflow,
    nodeAt,
    onConnect,
    onLoop,
    onMove,
    onMoveStart,
    onNotes,
    onSelect,
    toCanvas,
  ]);

  const startPan = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    gesture.current = {
      type: "pan",
      sx: e.clientX,
      sy: e.clientY,
      vx: view.x,
      vy: view.y,
      moved: false,
    };
  };
  const startNode = (e: ReactPointerEvent, key: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = layout[key] ?? { x: 0, y: 0 };
    gesture.current = {
      type: "node",
      key,
      sx: e.clientX,
      sy: e.clientY,
      ox: p.x,
      oy: p.y,
      moved: false,
    };
  };
  const startLink = (
    e: ReactPointerEvent,
    from: string,
    opts: { port?: string; error?: boolean; loop?: boolean } = {},
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    gesture.current = { type: "connect", from, ...opts };
    const p = toCanvas(e.clientX, e.clientY);
    setLinking({ from, ...opts, x: p.x, y: p.y, over: null });
  };

  const nodeKeys = (e: KeyboardEvent, key: string) => {
    const step = e.shiftKey ? 80 : 20;
    const d = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[e.key];
    if (d) {
      e.preventDefault();
      const p = layout[key] ?? { x: 0, y: 0 };
      onMoveStart();
      onMove(key, { x: p.x + d[0]!, y: p.y + d[1]! });
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(key === BRIEF ? { type: "brief" } : { type: "step", key });
    } else if ((e.key === "Delete" || e.key === "Backspace") && key !== BRIEF) {
      e.preventDefault();
      onDelete(key);
    }
  };

  const edges = edgesOf(draft.workflow);
  const roots = steps.filter((s) => (s.needs ?? []).length === 0);
  const brief = layout[BRIEF] ?? { x: 40, y: 40 };
  /** Where a connector leaves: a named output's dot, the failure dot, or the right-hand dot. */
  const anchorOut = (k: string, port?: string, error?: boolean) => {
    const p = layout[k] ?? { x: 0, y: 0 };
    const s = byKey.get(k);
    if (error && s) return { x: p.x + NODE_W - 28, y: p.y + nodeHeight(s) };
    const i = s && port ? portsOf(s).findIndex((x) => x.key === port) : -1;
    if (i >= 0)
      return {
        x: p.x + NODE_W,
        y: p.y + PORT_TOP + i * PORT_ROW + PORT_ROW / 2,
      };
    return { x: p.x + NODE_W, y: p.y + NODE_H / 2 };
  };
  const anchorIn = (k: string) => {
    const p = layout[k] ?? { x: 0, y: 0 };
    return { x: p.x, y: p.y + NODE_H / 2 };
  };
  const curve = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    down = false,
  ) => {
    const dx = Math.max(48, Math.abs(b.x - a.x) / 2);
    return down
      ? `M ${a.x} ${a.y} C ${a.x} ${a.y + 60}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
      : `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  };
  // Midpoint of the cubic curve, for the label chip.
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  const isSelEdge = (e: Edge) =>
    selected?.type === "edge" &&
    selected.from === e.from &&
    selected.to === e.to;
  const titleByKey = new Map(steps.map((s) => [s.key, titleOf(s)]));
  /** A loop arcs under the nodes, from the end's bottom-left back to the start's bottom. */
  const loopEnds = (from: string, to: { x: number; y: number } | string) => {
    const p = layout[from] ?? { x: 0, y: 0 };
    const src = byKey.get(from);
    const a = { x: p.x + 30, y: p.y + (src ? nodeHeight(src) : NODE_H) };
    if (typeof to !== "string") return { a, b: to, d: 60 };
    const q = layout[to] ?? { x: 0, y: 0 };
    const dst = byKey.get(to);
    const b = { x: q.x + NODE_W / 2 + (to === from ? 50 : 0), y: q.y + (dst ? nodeHeight(dst) : NODE_H) };
    return { a, b, d: 56 + Math.abs(a.x - b.x) * 0.08 };
  };
  const loopPath = ({ a, b, d }: { a: { x: number; y: number }; b: { x: number; y: number }; d: number }) =>
    `M ${a.x} ${a.y} C ${a.x} ${Math.max(a.y, b.y) + d}, ${b.x} ${Math.max(a.y, b.y) + d}, ${b.x} ${b.y}`;
  const loops = steps.filter((s) => s.loop && byKey.has(s.loop.to));

  return (
    <div className="flex h-full flex-col">
      <div
        ref={box}
        role="group"
        aria-label="Workflow canvas"
        aria-describedby="canvas-help"
        onPointerDown={startPan}
        className="canvas-grid relative min-h-[380px] flex-1 touch-none overflow-hidden bg-sunken select-none"
        style={{
          backgroundSize: `${20 * view.k}px ${20 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
          cursor: linking ? "crosshair" : "grab",
        }}
      >
        <p id="canvas-help" className="sr-only">
          Each step is a button: select it to edit it in the panel, where "Runs
          after" and the connector list set its connections. With a step
          focused, arrow keys move it and Delete removes it. Connector labels
          are buttons that open the connector's settings. Drag from a dot on a
          step's right edge to another step to connect them, from the red dot
          underneath to handle its failure, or from the violet dot on top back to
          an earlier step to repeat. Loop settings are also in each step's panel.
        </p>
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          }}
        >
          {/* Sticky notes sit behind everything else. */}
          {notes.map((n) => (
            <div
              key={n.id}
              className="absolute flex flex-col rounded-[10px] border border-warn-line bg-warn-soft shadow-sm"
              style={{ left: n.x, top: n.y, width: NOTE_W }}
            >
              <div
                className="flex cursor-grab items-center justify-between px-2 pt-1 text-[11px] font-semibold text-warn-ink"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  gesture.current = {
                    type: "note",
                    id: n.id,
                    sx: e.clientX,
                    sy: e.clientY,
                    ox: n.x,
                    oy: n.y,
                    moved: false,
                  };
                }}
              >
                <span>Note</span>
                <button
                  type="button"
                  aria-label="Delete this note"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() =>
                    onNotes((ns) => ns.filter((x) => x.id !== n.id))
                  }
                  className="rounded px-1 text-warn-ink hover:bg-warn-line"
                >
                  ×
                </button>
              </div>
              <textarea
                aria-label="Note text"
                value={n.text}
                rows={4}
                placeholder="Write a note for whoever edits this next"
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) =>
                  onNotes(
                    (ns) =>
                      ns.map((x) =>
                        x.id === n.id ? { ...x, text: e.target.value } : x,
                      ),
                    false,
                  )
                }
                className="m-1 resize-y rounded-md border-0 bg-transparent p-1.5 text-[12px] leading-snug text-ink placeholder:text-warn-ink focus:bg-surface"
              />
            </div>
          ))}

          <svg
            className="pointer-events-none absolute top-0 left-0 overflow-visible"
            width="1"
            height="1"
            aria-hidden
          >
            <defs>
              <marker id="arrow-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={LOOP_LOOK.stroke} />
              </marker>
              {(["always", "if", "else", "error", "on"] as const).map((k) => (
                <marker
                  key={k}
                  id={`arrow-${k}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M 0 0 L 10 5 L 0 10 z"
                    fill={
                      k === "on" ? "var(--accent)" : CONNECTOR_LOOK[k].stroke
                    }
                  />
                </marker>
              ))}
            </defs>
            {roots.map((s) => (
              <path
                key={`b-${s.key}`}
                d={curve(
                  { x: brief.x + NODE_W, y: brief.y + NODE_H / 2 },
                  anchorIn(s.key),
                )}
                fill="none"
                stroke="var(--line-dashed)"
                strokeWidth={1.5}
                strokeDasharray="5 5"
                markerEnd="url(#arrow-always)"
              />
            ))}
            {edges.map((e) => {
              const d = curve(
                anchorOut(e.from, e.port, e.type === "error"),
                anchorIn(e.to),
                e.type === "error",
              );
              const on =
                isSelEdge(e) ||
                (selected?.type === "step" &&
                  (selected.key === e.from || selected.key === e.to));
              const look = CONNECTOR_LOOK[e.type];
              return (
                <g key={`${e.from}-${e.to}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      onSelect({ type: "edge", from: e.from, to: e.to });
                    }}
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke={isSelEdge(e) ? "var(--accent)" : look.stroke}
                    strokeWidth={on ? 2.75 : 1.75}
                    strokeDasharray={
                      e.type === "else"
                        ? "7 4"
                        : e.type === "error"
                          ? "3 4"
                          : undefined
                    }
                    markerEnd={
                      isSelEdge(e) ? "url(#arrow-on)" : `url(#arrow-${e.type})`
                    }
                  />
                </g>
              );
            })}
            {loops.map((s) => {
              const d = loopPath(loopEnds(s.key, s.loop!.to));
              const on = selected?.type === "loop" && selected.key === s.key;
              return (
                <g key={`loop-${s.key}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      onSelect({ type: "loop", key: s.key });
                    }}
                  />
                  <path d={d} fill="none" stroke={LOOP_LOOK.stroke} strokeWidth={on ? 2.75 : 1.9} strokeDasharray="8 3 2 3" markerEnd="url(#arrow-loop)" />
                </g>
              );
            })}
            {linking?.loop ? (
              <path
                d={loopPath(loopEnds(linking.from, linking.over ?? { x: linking.x, y: linking.y }))}
                fill="none"
                stroke={LOOP_LOOK.stroke}
                strokeWidth={2}
                strokeDasharray="6 4"
              />
            ) : linking ? (
              <path
                d={curve(
                  anchorOut(linking.from, linking.port, linking.error),
                  linking.over
                    ? anchorIn(linking.over)
                    : { x: linking.x, y: linking.y },
                  linking.error,
                )}
                fill="none"
                stroke={linking.error ? "var(--bad)" : "var(--accent)"}
                strokeWidth={2}
                strokeDasharray="6 4"
              />
            ) : null}
          </svg>

          {/* The brief: what someone fills in to start a task. Steps with nothing before them start from it. */}
          <div
            role="button"
            tabIndex={0}
            aria-pressed={selected?.type === "brief"}
            aria-describedby="node-desc-brief"
            onPointerDown={(e) => startNode(e, BRIEF)}
            onKeyDown={(e) => nodeKeys(e, BRIEF)}
            className={cx(
              "absolute flex cursor-grab items-center gap-2.5 rounded-[14px] border-2 border-dashed bg-surface px-3 shadow-sm",
              selected?.type === "brief"
                ? "border-accent ring-2 ring-accent/30"
                : "border-line-dashed",
            )}
            style={{
              left: brief.x,
              top: brief.y,
              width: NODE_W,
              height: NODE_H,
            }}
          >
            <span id="node-desc-brief" hidden>
              What someone fills in to start a task. Steps with nothing before
              them start from it.
            </span>
            <Tile text="B" palette="grey" size={30} />
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-semibold">Brief</span>
              <span className="truncate text-xs text-muted">
                {draft.inputFields.map((f) => f.label).join(", ") ||
                  "No fields yet"}
              </span>
            </span>
          </div>

          {steps.map((s) => {
            const p = layout[s.key] ?? { x: 0, y: 0 };
            const look = KIND_LOOK[s.kind];
            const isSel = selected?.type === "step" && selected.key === s.key;
            const warn = warnings.get(s.key);
            const after = (s.needs ?? []).map(
              (n) => titleByKey.get(typeof n === "string" ? n : n.step) ?? n,
            );
            const ports = portsOf(s);
            return (
              <div
                key={s.key}
                role="button"
                tabIndex={0}
                aria-pressed={isSel}
                aria-describedby={`node-desc-${s.key}`}
                onPointerDown={(e) => startNode(e, s.key)}
                onKeyDown={(e) => nodeKeys(e, s.key)}
                className={cx(
                  "absolute flex cursor-grab flex-col rounded-[14px] border bg-surface px-3 shadow-sm transition-shadow",
                  ports.length
                    ? "justify-start pt-2.5"
                    : "justify-center gap-1",
                  isSel
                    ? "border-accent ring-2 ring-accent/30"
                    : linking?.over === s.key
                      ? "border-accent"
                      : warn
                        ? "border-warn-strong"
                        : "border-line-strong",
                  s.disabled && "opacity-60",
                )}
                style={{
                  left: p.x,
                  top: p.y,
                  width: NODE_W,
                  height: nodeHeight(s),
                }}
              >
                {/* Hidden, so the visible title and line stay the node's name; this is read as its description. */}
                <span id={`node-desc-${s.key}`} hidden>
                  {`${look.label}.${s.disabled ? " Turned off." : ""} ${after.length ? `Runs after ${after.join(", ")}.` : "Starts from the brief."}${ports.length ? ` Outputs: ${ports.map((x) => x.label).join(", ")}.` : ""}${s.loop ? ` Loops back to ${titleByKey.get(s.loop.to) ?? s.loop.to}, at most ${s.loop.max} rounds.` : ""}${s.key === result ? " Its output is the result." : ""}${warn ? ` Needs setup: ${warn}.` : ""}`}
                </span>
                <span className="flex items-center gap-2.5">
                  <Tile text={look.short} palette={look.palette} size={30} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-semibold">
                      {titleOf(s)}
                    </span>
                    <span className="truncate text-xs text-muted">
                      {describe(s)}
                    </span>
                  </span>
                </span>
                {ports.length ? null : (
                  <span className="flex gap-1 pl-10" aria-hidden>
                    {s.key === result ? <Pill tone="good">Result</Pill> : null}
                    {s.disabled ? (
                      <Pill>Off</Pill>
                    ) : s.optional ? (
                      <Pill>Optional</Pill>
                    ) : null}
                    {s.kind === "workspace" && s.repeat ? (
                      <Pill tone="accent">
                        {s.repeat.mode === "times"
                          ? `×${s.repeat.count}`
                          : s.repeat.mode === "each"
                            ? "Each item"
                            : "Until"}
                      </Pill>
                    ) : null}
                    {s.join && s.join !== "any" ? (
                      <Pill>{s.join === "all" ? "Needs all" : "First in"}</Pill>
                    ) : null}
                    {warn ? <Pill tone="warn">Needs setup</Pill> : null}
                  </span>
                )}
                {/* Named outputs, each with its own dot to drag from. */}
                {ports.map((port, i) => (
                  <span
                    key={port.key}
                    aria-hidden
                    className="absolute right-3 left-3 flex items-center justify-end gap-1.5 text-[11px] font-semibold text-ink-2"
                    style={{ top: PORT_TOP + i * PORT_ROW, height: PORT_ROW }}
                  >
                    <span className="truncate">{port.label}</span>
                    <span
                      title={`Drag to connect the ${port.label} output`}
                      onPointerDown={(e) =>
                        startLink(e, s.key, { port: port.key })
                      }
                      className={cx(
                        "absolute -right-[21px] h-3.5 w-3.5 cursor-crosshair rounded-full border-2 bg-surface hover:bg-accent",
                        port.key === "else" || port.key === "other"
                          ? "border-warn-strong"
                          : "border-accent",
                      )}
                    />
                  </span>
                ))}
                {/* Connection dots: arrows arrive on the left; drag from the right one to connect. */}
                <span
                  aria-hidden
                  className="absolute top-[33px] -left-[7px] h-3 w-3 rounded-full border-2 border-line-dashed bg-surface"
                />
                {ports.length ? null : (
                  <span
                    aria-hidden
                    title="Drag to connect"
                    onPointerDown={(e) => startLink(e, s.key)}
                    className="absolute top-[31px] -right-[9px] h-4 w-4 cursor-crosshair rounded-full border-2 border-accent bg-surface hover:bg-accent"
                  />
                )}
                {s.kind === "stop" ? null : (
                  <span
                    aria-hidden
                    title="Drag back to an earlier step (or this one) to repeat"
                    onPointerDown={(e) => startLink(e, s.key, { loop: true })}
                    className="absolute -top-[7px] left-[22px] h-3 w-3 cursor-crosshair rounded-full border-2 bg-surface"
                    style={{ borderColor: LOOP_LOOK.stroke }}
                  />
                )}
                {canFail(s) ? (
                  <span
                    aria-hidden
                    title="Drag to say what happens if this step fails"
                    onPointerDown={(e) => startLink(e, s.key, { error: true })}
                    className="absolute -bottom-[7px] right-[22px] h-3 w-3 cursor-crosshair rounded-full border-2 border-bad bg-surface hover:bg-bad"
                  />
                ) : null}
              </div>
            );
          })}

          {/* Connector labels: buttons, so connectors can be reached and edited with the keyboard. */}
          {edges.map((e) => {
            const label = edgeLabel(e);
            const sel = isSelEdge(e);
            if (!label && !sel) return null;
            const m = mid(
              anchorOut(e.from, e.port, e.type === "error"),
              anchorIn(e.to),
            );
            return (
              <button
                key={`l-${e.from}-${e.to}`}
                type="button"
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={() =>
                  onSelect({ type: "edge", from: e.from, to: e.to })
                }
                aria-pressed={sel}
                aria-label={`Connector from ${titleByKey.get(e.from)} to ${titleByKey.get(e.to)}: ${CONNECTOR_LOOK[e.type].label}${
                  e.label || (e.type === "if" && e.when)
                    ? `, ${e.label || describeCondition(e.when!)}`
                    : ""
                }${e.note ? ", with an instruction" : ""}`}
                className={cx(
                  "absolute max-w-[220px] -translate-x-1/2 -translate-y-1/2 truncate rounded-full border bg-surface px-2 py-0.5 text-[11px] font-semibold shadow-sm",
                  sel
                    ? "border-accent text-accent-ink"
                    : e.type === "error"
                      ? "border-bad-line text-bad"
                      : e.type === "else"
                        ? "border-warn-line text-warn-ink"
                        : "border-line-strong text-ink-2",
                )}
                style={{ left: m.x, top: m.y }}
              >
                {label || CONNECTOR_LOOK[e.type].label}
              </button>
            );
          })}
          {loops.map((s) => {
            const { a, b, d } = loopEnds(s.key, s.loop!.to);
            const sel = selected?.type === "loop" && selected.key === s.key;
            return (
              <button
                key={`lc-${s.key}`}
                type="button"
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={() => onSelect({ type: "loop", key: s.key })}
                aria-pressed={sel}
                aria-label={`Loop from ${titleByKey.get(s.key)} back to ${titleByKey.get(s.loop!.to)}: ${loopLabel(s.loop!)}`}
                className={cx(
                  "absolute max-w-[240px] -translate-x-1/2 -translate-y-1/2 truncate rounded-full border bg-surface px-2 py-0.5 text-[11px] font-semibold shadow-sm",
                  sel ? "border-accent text-accent-ink" : "border-line-strong",
                )}
                style={{ left: (a.x + b.x) / 2, top: Math.max(a.y, b.y) + 0.75 * d, color: sel ? undefined : LOOP_LOOK.stroke }}
              >
                {loopLabel(s.loop!)}
              </button>
            );
          })}
        </div>
      </div>
      {/* Below the canvas, so no node can ever sit on top of these. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface px-3 py-1.5">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => zoomAt(1 / 1.2)}
            aria-label="Zoom out"
            className="h-8 w-8 rounded-md text-base font-bold text-ink-2 hover:bg-sunken"
          >
            −
          </button>
          <span
            className="flex w-12 items-center justify-center text-xs text-muted"
            aria-live="polite"
          >
            {Math.round(view.k * 100)}%
          </span>
          <button
            type="button"
            onClick={() => zoomAt(1.2)}
            aria-label="Zoom in"
            className="h-8 w-8 rounded-md text-base font-bold text-ink-2 hover:bg-sunken"
          >
            +
          </button>
          <button
            type="button"
            onClick={fit}
            className="h-8 rounded-md px-2 text-xs font-semibold text-ink-2 hover:bg-sunken"
          >
            Fit
          </button>
        </div>
        <span className="flex-1" />
        <div
          className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted"
          aria-hidden
        >
          {(Object.keys(CONNECTOR_LOOK) as (keyof typeof CONNECTOR_LOOK)[]).map(
            (k) => (
              <span key={k} className="flex items-center gap-1.5">
                <svg width="22" height="6">
                  <line
                    x1="0"
                    y1="3"
                    x2="22"
                    y2="3"
                    stroke={CONNECTOR_LOOK[k].stroke}
                    strokeWidth="2"
                    strokeDasharray={
                      k === "else" ? "5 3" : k === "error" ? "2 3" : undefined
                    }
                  />
                </svg>
                {CONNECTOR_LOOK[k].label}
              </span>
            ),
          )}
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6">
              <line x1="0" y1="3" x2="22" y2="3" stroke={LOOP_LOOK.stroke} strokeWidth="2" strokeDasharray="6 2 2 2" />
            </svg>
            {LOOP_LOOK.label}
          </span>
        </div>
      </div>
    </div>
  );
}
