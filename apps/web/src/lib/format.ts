export const money = (usd: number): string => {
  if (usd === 0) return "$0.00";
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
};

/** Short dollars for sidebars and summaries: $36, $0.94. */
export const moneyShort = (usd: number): string => (usd >= 10 ? `$${Math.round(usd)}` : money(usd));

export const ago = (iso: string | null): string => {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return clock(iso);
};

/** "6:40 PM" today, "Yesterday", "Mon" this week, else a short date. */
export const clock = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

export const greeting = (): string => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

export const stepLabel = (key: string): string => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
