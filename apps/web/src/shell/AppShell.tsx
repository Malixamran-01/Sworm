import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { currentPushSubscription } from "../lib/notify";
import { realtime } from "../lib/realtime";
import { MenuIcon, SearchIcon } from "../ui/icons";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The drawer closes when you go somewhere, or press Escape.
  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  const navigate = useNavigate();
  useEffect(() => {
    realtime.navigate = (path) => void navigate({ to: path });
    // Learn whether this browser gets pushes, so desktop notifications do not double up.
    void currentPushSubscription().catch(() => {});
  }, [navigate]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-full bg-bg text-ink">
      <Sidebar
        open={menu}
        onClose={() => setMenu(false)}
        onOpenPalette={() => {
          setMenu(false);
          setPalette(true);
        }}
      />
      {menu && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" aria-hidden onClick={() => setMenu(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface px-3 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={menu}
            aria-controls="main-nav"
            onClick={() => setMenu(true)}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-ink hover:bg-line-soft"
          >
            <MenuIcon />
          </button>
          <span className="flex-1 text-base font-bold">Conclave</span>
          <button type="button" aria-label="Search or run a command" onClick={() => setPalette(true)} className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-2 hover:bg-line-soft">
            <SearchIcon size={18} />
          </button>
        </header>
        <Outlet />
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
