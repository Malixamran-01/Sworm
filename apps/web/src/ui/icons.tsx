import type { SVGProps } from "react";

/** Icons drawn from the v2 mockups: 24px grid, 2px stroke, round caps. */
const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
});

type P = { size?: number };

export const HomeIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M3 11l9-8 9 8M5 10v10h14V10" />
  </svg>
);
export const InboxIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z" />
  </svg>
);
export const PlugIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5" />
  </svg>
);
export const SearchIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);
export const GaugeIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M12 14l4-4M4 18a9 9 0 1 1 16 0" />
  </svg>
);
export const GearIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
  </svg>
);
export const SignOutIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />
  </svg>
);
export const SunIcon =({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
export const MoonIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M21 13a8 8 0 1 1-10-10 7 7 0 0 0 10 10z" />
  </svg>
);
export const PlusIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const CheckIcon = ({ size = 12 }: P) => (
  <svg {...base(size)} strokeWidth={3}>
    <path d="M5 12l5 5L20 7" />
  </svg>
);
export const CloseIcon = ({ size = 12 }: P) => (
  <svg {...base(size)} strokeWidth={3}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const ChevronIcon = ({ size = 14, open }: P & { open?: boolean }) => (
  <svg {...base(size)} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const MenuIcon = ({ size = 20 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);
