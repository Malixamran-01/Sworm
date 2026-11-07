import type { AlertLevel, NotificationPrefsDto, NotificationSettingsDto } from "@conclave/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { askPermission, currentPushSubscription, disablePush, enablePush, notificationsSupported, pushSupported } from "../../lib/notify";
import { Button, Card, ErrorNote, Input, Pill, Select } from "../../ui";

const KEY = ["notifications"];
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const toTime = (m: number | null) => (m === null ? "" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const fromTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null;
};
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });

const LEVELS: { value: AlertLevel; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "important", label: "Approvals, problems and budget" },
  { value: "none", label: "Inbox only" },
];

function device(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function Row({ title, help, children }: { title: ReactNode; help: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft py-3.5 last:border-b-0">
      <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="text-xs text-muted">{help}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function NotificationsSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: KEY, queryFn: api.notifications });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(notificationsSupported() ? Notification.permission : "unsupported");
  const [thisBrowser, setThisBrowser] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const zone = browserZone();

  useEffect(() => {
    void currentPushSubscription().then((s) => setThisBrowser(s?.endpoint ?? null));
  }, []);

  const store = (next: NotificationSettingsDto) => qc.setQueryData(KEY, next);
  // Times are the browser's, so the zone goes with every change.
  const save = useMutation({ mutationFn: (patch: Partial<NotificationPrefsDto>) => api.updateNotifications({ timeZone: zone, ...patch }), onSuccess: store });
  const rule = useMutation({ mutationFn: (v: { workspaceId: string; level: AlertLevel }) => api.setAlertRule(v.workspaceId, v.level), onSuccess: store });
  const push = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) await enablePush(settings.data!.server.pushPublicKey!);
      else await disablePush();
      setThisBrowser((await currentPushSubscription())?.endpoint ?? null);
      setPermission(Notification.permission);
      return api.notifications();
    },
    onSuccess: store,
  });
  const removeDevice = useMutation({ mutationFn: (id: string) => api.removePush(id), onSuccess: store });
  const test = useMutation({
    mutationFn: api.testNotification,
    onSuccess: (r) =>
      setTestResult(
        [r.desktop ? "desktop" : null, r.pushes ? `${r.pushes} push${r.pushes === 1 ? "" : "es"}` : null, r.email ? "an email" : null].filter(Boolean).join(", ") || "nothing (every channel is off)",
      ),
  });

  if (!settings.data) return <ErrorNote error={settings.error} />;
  const { prefs, server, pushDevices, quietNow } = settings.data;
  const levelOf = (id: string) => settings.data.rules.find((r) => r.workspaceId === id)?.level ?? "all";
  const quietOn = prefs.quietStart !== null && prefs.quietEnd !== null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card as="section" aria-labelledby="n-where" className="flex flex-col p-5">
        <h2 id="n-where" className="m-0 mb-1 text-[15px] font-semibold">
          Where you hear about things
        </h2>
        <p className="m-0 mb-2 text-xs text-muted">Everything lands in your inbox. These add a nudge on top.</p>

        <Row
          title={
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={prefs.desktop} onChange={(e) => save.mutate({ desktop: e.target.checked })} className="size-4 accent-[var(--accent)]" />
              Desktop notifications
            </label>
          }
          help={
            permission === "denied"
              ? "Blocked in this browser. Allow notifications for this site in the browser's settings."
              : permission === "unsupported"
                ? "This browser cannot show notifications."
                : "While Conclave is open in a tab you are not looking at."
          }
        >
          {permission === "default" && (
            <Button size="sm" onClick={() => void askPermission().then(setPermission)}>
              Allow in this browser
            </Button>
          )}
        </Row>

        <Row
          title="Web push"
          help={
            !pushSupported()
              ? "Needs HTTPS (or localhost) and a browser that supports push."
              : permission === "denied"
                ? "Notifications are blocked for this site in this browser."
              : thisBrowser
                ? "This browser gets pushes, even with Conclave closed."
                : "Reach this browser even when Conclave is closed."
          }
        >
          {pushSupported() && permission !== "denied" && server.pushPublicKey && (
            <Button size="sm" variant={thisBrowser ? "secondary" : "primary"} disabled={push.isPending} onClick={() => push.mutate(!thisBrowser)}>
              {push.isPending ? "Working…" : thisBrowser ? "Turn off here" : "Turn on for this browser"}
            </Button>
          )}
        </Row>
        {pushDevices.length > 0 && (
          <ul aria-label="Browsers that get pushes" className="m-0 mb-2 flex list-none flex-col gap-1.5 p-0">
            {pushDevices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg bg-sunken px-3 py-2 text-[13px]">
                <span>
                  {device(d.userAgent)} <span className="text-muted">· added {ago(d.createdAt)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => removeDevice.mutate(d.id)} aria-label={`Remove ${device(d.userAgent)}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <Row
          title="Email digest"
          help={server.email ? "A summary of what came in, with what still needs you first." : "Email is not set up on this server. An admin sets CONCLAVE_SMTP_URL."}
        >
          <Select
            aria-label="Email digest"
            value={prefs.emailDigest}
            disabled={!server.email}
            onChange={(e) => save.mutate({ emailDigest: e.target.value as NotificationPrefsDto["emailDigest"] })}
            className="!w-auto"
          >
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly, on Mondays</option>
          </Select>
          {prefs.emailDigest !== "off" && (
            <Select aria-label="Digest time" value={prefs.digestHour} onChange={(e) => save.mutate({ digestHour: Number(e.target.value) })} className="!w-auto">
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  at {hourLabel(h)}
                </option>
              ))}
            </Select>
          )}
        </Row>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
            Send a test
          </Button>
          {testResult && <span className="text-xs text-muted" role="status">Sent: {testResult}.</span>}
        </div>
        <ErrorNote error={save.error ?? push.error ?? test.error ?? removeDevice.error} />
      </Card>

      <div className="flex flex-col gap-4">
        <Card as="section" aria-labelledby="n-quiet" className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 id="n-quiet" className="m-0 text-[15px] font-semibold">
              Quiet hours
            </h2>
            {quietNow && <Pill tone="accent">Quiet now</Pill>}
          </div>
          <label className="flex items-center gap-2 text-[13px] font-semibold">
            <input
              type="checkbox"
              checked={quietOn}
              onChange={(e) => save.mutate(e.target.checked ? { quietStart: 23 * 60, quietEnd: 7 * 60 } : { quietStart: null, quietEnd: null })}
              className="size-4 accent-[var(--accent)]"
            />
            Hold notifications overnight
          </label>
          {quietOn && (
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <label htmlFor="quiet-from">From</label>
              <Input
                id="quiet-from"
                type="time"
                defaultValue={toTime(prefs.quietStart)}
                onBlur={(e) => fromTime(e.target.value) !== null && save.mutate({ quietStart: fromTime(e.target.value) })}
                className="!w-[120px]"
              />
              <label htmlFor="quiet-to">to</label>
              <Input
                id="quiet-to"
                type="time"
                defaultValue={toTime(prefs.quietEnd)}
                onBlur={(e) => fromTime(e.target.value) !== null && save.mutate({ quietEnd: fromTime(e.target.value) })}
                className="!w-[120px]"
              />
            </div>
          )}
          <p className="m-0 text-xs text-muted">
            Ordinary items wait until quiet hours end. Safety checks still ring. Times are in {prefs.timeZone === zone ? zone : `${prefs.timeZone} (this browser is in ${zone})`}.
          </p>
        </Card>

        <Card as="section" aria-labelledby="n-rules" className="flex flex-col gap-2 p-5">
          <h2 id="n-rules" className="m-0 text-[15px] font-semibold">
            Per workspace
          </h2>
          <p className="m-0 text-xs text-muted">How loud each workspace may be for you. Nothing is ever hidden from the inbox.</p>
          {workspaces.data?.length === 0 && <p className="m-0 text-[13px] text-muted">No workspaces yet.</p>}
          {workspaces.data?.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft py-2 last:border-b-0">
              <label htmlFor={`rule-${w.id}`} className="text-[13px] font-medium">
                {w.name}
              </label>
              <Select id={`rule-${w.id}`} value={levelOf(w.id)} onChange={(e) => rule.mutate({ workspaceId: w.id, level: e.target.value as AlertLevel })} className="!w-auto">
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </div>
          ))}
          <ErrorNote error={rule.error} />
        </Card>
      </div>
    </div>
  );
}
