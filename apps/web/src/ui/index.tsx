import type { ButtonHTMLAttributes, ComponentProps, CSSProperties, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { ApiError } from "../lib/api";
import { tileColors, type TilePalette } from "../lib/palette";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ------------------------------------------------------------------ Buttons

type Variant = "primary" | "secondary" | "quiet" | "success" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent border-transparent hover:brightness-110 font-semibold",
  secondary: "bg-surface text-ink border-line-strong hover:bg-sunken font-semibold",
  quiet: "bg-sunken text-ink-2 border-line hover:border-line-strong",
  success: "bg-good text-on-accent border-transparent hover:brightness-110 font-semibold",
  ghost: "bg-transparent text-ink-2 border-transparent hover:bg-sunken font-semibold",
  danger: "bg-surface text-bad border-line-strong hover:bg-bad-soft font-semibold",
};
const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 rounded-lg text-[13px]",
  md: "h-9 px-3.5 rounded-[9px] text-[13px]",
  lg: "h-10 px-5 rounded-[10px] text-sm",
};

export function Button({ variant = "secondary", size = "md", className, ...props }: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 border transition disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    />
  );
}

// ------------------------------------------------------------------- Pills

export type Tone = "neutral" | "accent" | "good" | "warn" | "bad";
const TONES: Record<Tone, string> = {
  neutral: "bg-line-soft text-muted",
  accent: "bg-accent-soft text-accent-ink",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn-ink",
  bad: "bg-bad-soft text-bad",
};

export function Pill({ tone = "neutral", children, live, className }: { tone?: Tone; children: ReactNode; live?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1 rounded-full px-[9px] py-[3px] text-[11px] font-bold whitespace-nowrap", TONES[tone], className)}>
      {live ? <span className="pulse h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

const STATUS: Record<string, { label: string; tone: Tone; live?: boolean }> = {
  queued: { label: "Queued", tone: "neutral", live: true },
  running: { label: "Running", tone: "accent", live: true },
  waiting: { label: "Needs review", tone: "warn" },
  succeeded: { label: "Done", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  pending: { label: "Pending", tone: "neutral" },
  superseded: { label: "Revised", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
  not_taken: { label: "Not taken", tone: "neutral" },
  working: { label: "Working", tone: "good" },
  rate_limited: { label: "Rate limited", tone: "warn" },
  signed_out: { label: "Signed out", tone: "bad" },
  unreachable: { label: "Unreachable", tone: "bad" },
  unknown: { label: "Not tested", tone: "neutral" },
  off: { label: "Turned off", tone: "neutral" },
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return (
    <Pill tone={s.tone} live={s.live ?? false}>
      {s.label}
    </Pill>
  );
}

// ------------------------------------------------------------- Tiles, cards

const TILE_SIZES = {
  22: "h-[22px] w-[22px] rounded-md text-[12px]",
  30: "h-[30px] w-[30px] rounded-lg text-[13px]",
  32: "h-8 w-8 rounded-[9px] text-[12px]",
  36: "h-9 w-9 rounded-[10px] text-sm",
  44: "h-11 w-11 rounded-xl text-lg",
} as const;

export function Tile({ text, palette, size = 30, round, className }: { text: string; palette: TilePalette; size?: keyof typeof TILE_SIZES; round?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-flex shrink-0 items-center justify-center font-bold", TILE_SIZES[size], round && "!rounded-full", className)}
      style={tileColors(palette)}
    >
      {text}
    </span>
  );
}

export function Card({ children, className, style, as: As = "div", ...rest }: { children: ReactNode; className?: string; style?: CSSProperties; as?: "div" | "section" | "article" } & Record<string, unknown>) {
  return (
    <As {...rest} style={style} className={cx("rounded-[14px] border border-line bg-surface", className)}>
      {children}
    </As>
  );
}

export function SectionTitle({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <h2 className={cx("m-0 text-base font-semibold", className)}>
      {children}
      {count !== undefined ? <span className="font-medium text-muted"> · {count}</span> : null}
    </h2>
  );
}

// ------------------------------------------------------------------ Fields

export function Field({ label, help, children, htmlFor, className }: { label: ReactNode; help?: ReactNode; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-semibold">
        {label}
      </label>
      {children}
      {help ? <p className="m-0 text-xs text-muted">{help}</p> : null}
    </div>
  );
}

const control = "w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted";
export const Input = ({ className, ...props }: ComponentProps<"input">) => <input {...props} className={cx(control, "h-[38px]", className)} />;
export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={cx(control, "min-h-20 resize-y rounded-[10px] py-2.5 leading-relaxed", className)} />
);
export const Select = ({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={cx(control, "h-[38px] px-2", className)} />
);

/** Filter buttons like "All 12 · Needs review 1". */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("h-8 rounded-lg px-3 text-[13px]", value === o.value ? "bg-line font-semibold text-ink" : "text-ink-2 hover:bg-line-soft")}
        >
          {o.label}
          {o.count !== undefined ? ` ${o.count}` : ""}
        </button>
      ))}
    </div>
  );
}

/** Chips like the task-type picker: the selected one is dark. */
export function ChipGroup<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-[34px] rounded-full px-3.5 text-[13px]",
            value === o.value ? "bg-inverse font-semibold text-on-inverse" : "border border-line-strong bg-surface text-ink hover:bg-sunken",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Feedback

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const messages =
    error instanceof ApiError ? (error.errors.length ? error.errors : [error.message]) : [error instanceof Error ? error.message : String(error)];
  return (
    <div role="alert" className="rounded-[10px] border border-bad-line bg-bad-soft px-3 py-2 text-[13px] text-bad">
      {messages.map((m) => (
        <p key={m} className="m-0">
          {m}
        </p>
      ))}
    </div>
  );
}

export function Empty({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-[14px] border border-dashed border-line-dashed px-6 py-10 text-center", className)}>
      <p className="m-0 font-semibold">{title}</p>
      {children ? <div className="mt-1 text-[13px] text-muted">{children}</div> : null}
    </div>
  );
}

export function Progress({ value, tone = "accent" }: { value: number; tone?: "accent" | "bad" }) {
  return (
    <div className="h-2 overflow-hidden rounded bg-line-soft" aria-hidden>
      <div className={cx("h-full rounded", tone === "bad" ? "bg-bad" : "bg-accent")} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h1 className="m-0 text-[26px] font-bold tracking-[-0.02em]">{title}</h1>
        {subtitle ? <p className="m-0 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions}
    </header>
  );
}
