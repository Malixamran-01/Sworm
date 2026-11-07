import {
  newId,
  topics,
  type AlertLevel,
  type DigestFrequency,
  type InboxItemDto,
  type InboxKind,
  type NotificationPrefsDto,
  type NotificationSettingsDto,
} from "@conclave/contract";
import { iso, type Db, type Queryable } from "@conclave/db";
import nodemailer from "nodemailer";
import webpush from "web-push";
import { toInboxDto, type InboxRow } from "./dto";
import { invalid, notFound, type Actor } from "./errors";
import { emit, type EventBus } from "./events";
import type { SecretVault } from "./secrets";

/**
 * Notifications (NOTE-003, NOTE-004). Every item lands in the inbox first, in
 * the same transaction as the change that caused it. This service then
 * delivers it further, after commit: a desktop notification over the realtime
 * socket, web push to each registered browser, and an email digest. Quiet
 * hours hold ordinary items back until they end; urgent items (safety checks)
 * still go out. Per-workspace alert rules say how loud each workspace may be.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** SMTP through nodemailer: `smtp://user:pass@host:587` or `smtps://…`. */
export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send(m) {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
}

export interface NotifierOptions {
  mailer?: Mailer;
  /** Where links in pushes and emails point, e.g. https://conclave.example.com */
  publicUrl?: string;
  /** VAPID contact, a mailto: or https: URL (RFC 8292). */
  vapidSubject?: string;
  /** Hosts that may receive pushes (suffix match). Defaults to the browser vendors' push services. */
  pushHosts?: string[];
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Browser push services. A subscription to any other host is refused, so it cannot be used to make the server call inside the network. */
export const DEFAULT_PUSH_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];

const IMPORTANT: ReadonlySet<InboxKind> = new Set(["approval", "problem", "budget"]);
/** More than this many items for one person in one pass become a single summary push. */
const SUMMARY_AFTER = 3;
const STALE_SENDING_MS = 5 * 60_000;

interface PrefsRow {
  desktop: boolean;
  push: boolean;
  email_digest: DigestFrequency;
  digest_hour: number;
  quiet_start: number | null;
  quiet_end: number | null;
  time_zone: string;
  last_digest_at: Date | null;
}

const DEFAULT_PREFS: PrefsRow = {
  desktop: true,
  push: false,
  email_digest: "off",
  digest_hour: 8,
  quiet_start: null,
  quiet_end: null,
  time_zone: "UTC",
  last_digest_at: null,
};

interface Candidate extends InboxRow, Partial<PrefsRow> {
  user_id: string;
  org_id: string;
  level: AlertLevel | null;
  delivery: string;
}

interface PushSubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failures: number;
}

export interface DeliveryReport {
  sent: number;
  held: number;
  muted: number;
  pushes: number;
}

/** Local time in a zone, as minutes after midnight plus the calendar date and weekday. */
export function localClock(at: Date, timeZone: string): { minutes: number; date: string; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}`, weekday: weekdays.indexOf(parts.weekday!) };
}

/** True when `at` falls in the quiet window. Windows may wrap midnight (23:00–07:00). */
export function inQuietHours(prefs: Pick<PrefsRow, "quiet_start" | "quiet_end" | "time_zone">, at: Date): boolean {
  const { quiet_start: start, quiet_end: end } = prefs;
  if (start === null || end === null || start === undefined || end === undefined || start === end) return false;
  const m = localClock(at, prefs.time_zone || "UTC").minutes;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class Notifier {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly vault: SecretVault;
  private readonly opts: NotifierOptions;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly pushHosts: string[];
  private timer: NodeJS.Timeout | undefined;
  private stopListening: (() => void) | undefined;
  private soon: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;

  constructor(db: Db, bus: EventBus, vault: SecretVault, opts: NotifierOptions = {}) {
    this.db = db;
    this.bus = bus;
    this.vault = vault;
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.pushHosts = opts.pushHosts ?? DEFAULT_PUSH_HOSTS;
  }

  get emailEnabled(): boolean {
    return !!this.opts.mailer;
  }

  // ------------------------------------------------------------------ settings

  async settings(actor: Actor): Promise<NotificationSettingsDto> {
    const prefs = await this.prefsRow(this.db, actor.userId);
    const rules = await this.db.query<{ workspace_id: string; name: string; level: AlertLevel }>(
      `select r.workspace_id, w.name, r.level from notification_rules r join workspaces w on w.id = r.workspace_id
        where r.user_id = $1 and w.org_id = $2 order by w.name`,
      [actor.userId, actor.orgId],
    );
    const devices = await this.db.query<{ id: string; user_agent: string; created_at: Date }>(
      `select id, user_agent, created_at from push_subscriptions where user_id = $1 order by created_at`,
      [actor.userId],
    );
    return {
      prefs: toPrefsDto(prefs),
      rules: rules.map((r) => ({ workspaceId: r.workspace_id, workspaceName: r.name, level: r.level })),
      server: { pushPublicKey: await this.pushPublicKey(actor.orgId), email: this.emailEnabled },
      pushDevices: devices.map((d) => ({ id: d.id, userAgent: d.user_agent, createdAt: iso(d.created_at)! })),
      quietNow: inQuietHours(prefs, this.now()),
    };
  }

  async updatePrefs(actor: Actor, patch: Partial<NotificationPrefsDto>): Promise<NotificationSettingsDto> {
    const errors: string[] = [];
    const minute = (v: number | null | undefined) => v === null || v === undefined || (Number.isInteger(v) && v >= 0 && v < 1440);
    if (!minute(patch.quietStart) || !minute(patch.quietEnd)) errors.push("Quiet hours must be times of day.");
    if (patch.digestHour !== undefined && !(Number.isInteger(patch.digestHour) && patch.digestHour >= 0 && patch.digestHour <= 23)) errors.push("The digest hour must be 0 to 23.");
    if (patch.timeZone !== undefined && !validTimeZone(patch.timeZone)) errors.push(`Unknown time zone "${patch.timeZone}".`);
    if (patch.emailDigest !== undefined && !["off", "daily", "weekly"].includes(patch.emailDigest)) errors.push("The digest is off, daily or weekly.");
    if (patch.emailDigest && patch.emailDigest !== "off" && !this.emailEnabled) errors.push("This server has no email set up, so digests cannot be sent.");
    if (errors.length) throw invalid(errors);

    const cur = toPrefsDto(await this.prefsRow(this.db, actor.userId));
    const next = { ...cur, ...patch };
    // Quiet hours are both set or both cleared.
    if ((next.quietStart === null) !== (next.quietEnd === null)) throw invalid(["Give quiet hours a start and an end, or clear both."]);
    await this.db.query(
      `insert into notification_prefs (user_id, desktop, push, email_digest, digest_hour, quiet_start, quiet_end, time_zone, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (user_id) do update set desktop = excluded.desktop, push = excluded.push, email_digest = excluded.email_digest,
         digest_hour = excluded.digest_hour, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
         time_zone = excluded.time_zone, updated_at = now()`,
      [actor.userId, next.desktop, next.push, next.emailDigest, next.digestHour, next.quietStart, next.quietEnd, next.timeZone],
    );
    return this.settings(actor);
  }

  /** How loud one workspace may be for this person. "all" removes the rule. */
  async setRule(actor: Actor, workspaceId: string, level: AlertLevel): Promise<NotificationSettingsDto> {
    if (!["all", "important", "none"].includes(level)) throw invalid([`Unknown alert level "${level}".`]);
    const [ws] = await this.db.query(`select id from workspaces where id = $1 and org_id = $2`, [workspaceId, actor.orgId]);
    if (!ws) throw notFound("Workspace");
    if (level === "all") {
      await this.db.query(`delete from notification_rules where user_id = $1 and workspace_id = $2`, [actor.userId, workspaceId]);
    } else {
      await this.db.query(
        `insert into notification_rules (user_id, workspace_id, level) values ($1, $2, $3)
         on conflict (user_id, workspace_id) do update set level = excluded.level`,
        [actor.userId, workspaceId, level],
      );
    }
    return this.settings(actor);
  }

  // ------------------------------------------------------------------ web push

  /** The org's VAPID public key, made on first use. The private key lives in the vault. */
  async pushPublicKey(orgId: string): Promise<string> {
    return (await this.vapid(orgId)).publicKey;
  }

  private async vapid(orgId: string): Promise<{ publicKey: string; privateKey: string }> {
    const [row] = await this.db.query<{ public_key: string; secret_id: string }>(`select public_key, secret_id from push_keys where org_id = $1`, [orgId]);
    if (row) {
      const values = await this.vault.reveal(this.db, row.secret_id);
      return { publicKey: row.public_key, privateKey: values.privateKey! };
    }
    const keys = webpush.generateVAPIDKeys();
    await this.db.tx(async (q) => {
      const secretId = await this.vault.store(q, orgId, { privateKey: keys.privateKey });
      await q.query(`insert into push_keys (org_id, public_key, secret_id) values ($1, $2, $3) on conflict (org_id) do nothing`, [orgId, keys.publicKey, secretId]);
    });
    // Another request may have won the race; use whatever was stored.
    return this.vapid(orgId);
  }

  async subscribe(actor: Actor, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent = ""): Promise<NotificationSettingsDto> {
    let url: URL;
    try {
      url = new URL(sub.endpoint);
    } catch {
      throw invalid(["The push endpoint is not a URL."]);
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !this.pushHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      throw invalid([`Pushes can only go to a browser push service, not ${host}.`]);
    }
    if (!sub.keys?.p256dh || !sub.keys?.auth) throw invalid(["The push subscription has no keys."]);
    await this.db.query(
      `insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) values ($1, $2, $3, $4, $5, $6)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, failures = 0`,
      [newId(), actor.userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent.slice(0, 300)],
    );
    // Registering a browser means the person wants pushes.
    await this.updatePrefs(actor, { push: true });
    return this.settings(actor);
  }

  async unsubscribe(actor: Actor, by: { id?: string; endpoint?: string }): Promise<NotificationSettingsDto> {
    await this.db.query(`delete from push_subscriptions where user_id = $1 and (id::text = $2 or endpoint = $3)`, [actor.userId, by.id ?? "", by.endpoint ?? ""]);
    return this.settings(actor);
  }

  private async pushTo(orgId: string, userId: string, payload: { title: string; body: string; url: string; tag: string; urgent: boolean }): Promise<number> {
    const subs = await this.db.query<PushSubRow>(`select id, endpoint, p256dh, auth, failures from push_subscriptions where user_id = $1`, [userId]);
    if (subs.length === 0) return 0;
    const keys = await this.vapid(orgId);
    const subject = this.opts.vapidSubject ?? (this.opts.publicUrl?.startsWith("https://") ? this.opts.publicUrl : "mailto:admin@localhost");
    let sent = 0;
    for (const sub of subs) {
      const details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: payload.urgent ? 24 * 3600 : 4 * 3600,
        urgency: payload.urgent ? "high" : "normal",
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
      });
      try {
        const res = await this.fetch(details.endpoint, {
          method: details.method,
          headers: details.headers as Record<string, string>,
          body: details.body as unknown as Uint8Array<ArrayBuffer>,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404 || res.status === 410) {
          // The browser dropped the subscription.
          await this.db.query(`delete from push_subscriptions where id = $1`, [sub.id]);
        } else if (res.ok) {
          sent++;
          await this.db.query(`update push_subscriptions set failures = 0, last_sent_at = now() where id = $1`, [sub.id]);
        } else {
          await this.pushFailed(sub);
        }
      } catch {
        await this.pushFailed(sub);
      }
    }
    return sent;
  }

  private async pushFailed(sub: PushSubRow): Promise<void> {
    if (sub.failures + 1 >= 5) await this.db.query(`delete from push_subscriptions where id = $1`, [sub.id]);
    else await this.db.query(`update push_subscriptions set failures = failures + 1 where id = $1`, [sub.id]);
  }

  // ------------------------------------------------------------------ delivery

  private link(path: string): string {
    return `${(this.opts.publicUrl ?? "").replace(/\/$/, "")}${path}`;
  }

  /**
   * Deliver inbox items that have not gone out yet. Items in quiet hours stay
   * held; muted ones are marked and stay in the inbox only. Safe to run on
   * several servers at once: each claims its items with SKIP LOCKED.
   */
  async deliverPending(): Promise<DeliveryReport> {
    const now = this.now();
    const report: DeliveryReport = { sent: 0, held: 0, muted: 0, pushes: 0 };
    const claimed = await this.db.tx(async (q) => {
      const rows = await q.query<Candidate>(
        `select i.*, w.name as workspace_name, r.level, p.desktop, p.push, p.quiet_start, p.quiet_end, p.time_zone
           from inbox_items i
           left join workspaces w on w.id = i.workspace_id
           left join notification_rules r on r.user_id = i.user_id and r.workspace_id = i.workspace_id
           left join notification_prefs p on p.user_id = i.user_id
          where i.delivery in ('pending', 'held') or (i.delivery = 'sending' and i.delivered_at < $1)
          order by i.created_at
          limit 500
          for update of i skip locked`,
        [new Date(now.getTime() - STALE_SENDING_MS)],
      );
      const send: Candidate[] = [];
      for (const row of rows) {
        const level = row.level ?? "all";
        const outcome =
          level === "none" || (level === "important" && !IMPORTANT.has(row.kind))
            ? "muted"
            : row.resolved
              ? "skipped" // already handled (approved elsewhere, budget raised); no need to ring
              : !row.urgent && inQuietHours({ quiet_start: row.quiet_start ?? null, quiet_end: row.quiet_end ?? null, time_zone: row.time_zone ?? "UTC" }, now)
                ? "held"
                : "sending";
        if (outcome === "held") report.held++;
        if (outcome === "muted") report.muted++;
        if (outcome === "sending") send.push(row);
        if (outcome !== row.delivery) {
          await q.query(`update inbox_items set delivery = $2, delivered_at = $3 where id = $1`, [row.id, outcome, outcome === "held" ? null : now]);
        }
      }
      return send;
    });

    const byUser = new Map<string, Candidate[]>();
    for (const row of claimed) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
    for (const [userId, items] of byUser) {
      const first = items[0]!;
      const prefs = { desktop: first.desktop ?? DEFAULT_PREFS.desktop, push: first.push ?? DEFAULT_PREFS.push };
      const dtos = items.map((i) => toInboxDto(i));
      if (prefs.desktop) {
        for (const item of dtos) await emit(this.db, [topics.inbox(userId)], { type: "notification", item });
      }
      if (prefs.push) {
        const urgent = dtos.filter((d) => d.urgent);
        const ordinary = dtos.filter((d) => !d.urgent);
        // Urgent items always get their own push; a pile of ordinary ones becomes one summary.
        const pushes = [
          ...urgent.map((d) => pushPayload(d, this.link(`/inbox?item=${d.id}`))),
          ...(ordinary.length > SUMMARY_AFTER
            ? [{ title: `${ordinary.length} new items in your inbox`, body: summarize(ordinary), url: this.link("/inbox"), tag: "conclave-summary", urgent: false }]
            : ordinary.map((d) => pushPayload(d, this.link(`/inbox?item=${d.id}`)))),
        ];
        for (const p of pushes) report.pushes += await this.pushTo(first.org_id, userId, p);
      }
      await this.db.query(`update inbox_items set delivery = 'sent', delivered_at = $2 where id = any($1::uuid[])`, [items.map((i) => i.id), now]);
      report.sent += items.length;
    }
    return report;
  }

  /** Send each person's email digest when it is due (NOTE-003). Returns how many went out. */
  async sendDigests(): Promise<number> {
    if (!this.opts.mailer) return 0;
    const now = this.now();
    const people = await this.db.query<PrefsRow & { user_id: string; email: string; name: string }>(
      `select p.*, u.email, u.name from notification_prefs p join users u on u.id = p.user_id where p.email_digest <> 'off'`,
    );
    let sent = 0;
    for (const person of people) {
      if (!digestDue(person, now)) continue;
      // Claim the slot first, so two servers never send the same digest.
      const claimed = await this.db.query(
        `update notification_prefs set last_digest_at = $2 where user_id = $1 and last_digest_at is not distinct from $3 returning user_id`,
        [person.user_id, now, person.last_digest_at],
      );
      if (claimed.length === 0) continue;
      const since = person.last_digest_at ?? new Date(now.getTime() - 7 * 86_400_000);
      const items = await this.db.query<InboxRow & { level: AlertLevel | null }>(
        `select i.*, w.name as workspace_name, r.level from inbox_items i
           left join workspaces w on w.id = i.workspace_id
           left join notification_rules r on r.user_id = i.user_id and r.workspace_id = i.workspace_id
          where i.user_id = $1 and i.digested_at is null and i.created_at > $2 and coalesce(r.level, 'all') <> 'none'
          order by i.created_at desc limit 200`,
        [person.user_id, since],
      );
      if (items.length === 0) continue;
      const dtos = items.map((i) => toInboxDto(i));
      await this.opts.mailer.send({ to: person.email, ...digestEmail(dtos, person.name, this.link("/inbox"), person.email_digest) });
      await this.db.query(`update inbox_items set digested_at = $2 where id = any($1::uuid[])`, [items.map((i) => i.id), now]);
      sent++;
    }
    return sent;
  }

  /** Send a test through every channel this person has on, so they can check it works. */
  async test(actor: Actor): Promise<{ desktop: boolean; pushes: number; email: boolean }> {
    const prefs = await this.prefsRow(this.db, actor.userId);
    const item: InboxItemDto = {
      id: newId(),
      kind: "result",
      workspaceId: null,
      workspaceName: null,
      runId: null,
      approvalId: null,
      title: "Test notification",
      body: "Notifications from Conclave reach you here.",
      path: "Settings > Notifications",
      action: null,
      resolved: false,
      urgent: false,
      readAt: null,
      createdAt: this.now().toISOString(),
    };
    if (prefs.desktop) await emit(this.db, [topics.inbox(actor.userId)], { type: "notification", item });
    const pushes = await this.pushTo(actor.orgId, actor.userId, pushPayload(item, this.link("/settings")));
    let email = false;
    if (this.opts.mailer) {
      const [user] = await this.db.query<{ email: string; name: string }>(`select email, name from users where id = $1`, [actor.userId]);
      if (user) {
        await this.opts.mailer.send({ to: user.email, ...digestEmail([item], user.name, this.link("/inbox"), "test") });
        email = true;
      }
    }
    return { desktop: prefs.desktop, pushes, email };
  }

  /** One pass: deliver, then digests. */
  async tick(): Promise<void> {
    if (this.running) return void (await this.running);
    this.running = (async () => {
      await this.deliverPending();
      await this.sendDigests();
    })().finally(() => (this.running = undefined));
    await this.running;
  }

  /** Deliver soon after each new inbox item, and once a minute for quiet-hour releases and digests. */
  start(everyMs = 60_000): void {
    this.stopListening = this.bus.subscribe("*", (e) => {
      if (e.event.type !== "inbox.updated" || this.soon) return;
      this.soon = setTimeout(() => {
        this.soon = undefined;
        void this.tick().catch((err) => console.error("[notify] delivery failed", err));
      }, 50);
    });
    this.timer = setInterval(() => void this.tick().catch((err) => console.error("[notify] delivery failed", err)), everyMs);
  }

  async stop(): Promise<void> {
    this.stopListening?.();
    clearInterval(this.timer);
    clearTimeout(this.soon);
    await this.running?.catch(() => {});
  }

  private async prefsRow(q: Queryable, userId: string): Promise<PrefsRow> {
    const [row] = await q.query<PrefsRow>(`select * from notification_prefs where user_id = $1`, [userId]);
    return row ?? DEFAULT_PREFS;
  }
}

function toPrefsDto(p: PrefsRow): NotificationPrefsDto {
  return {
    desktop: p.desktop,
    push: p.push,
    emailDigest: p.email_digest,
    digestHour: p.digest_hour,
    quietStart: p.quiet_start,
    quietEnd: p.quiet_end,
    timeZone: p.time_zone,
  };
}

function pushPayload(item: InboxItemDto, url: string) {
  return { title: item.title, body: (item.body || item.path).slice(0, 240), url, tag: item.id, urgent: item.urgent };
}

const KIND_WORDS: Record<InboxKind, [string, string]> = {
  approval: ["approval waiting", "approvals waiting"],
  result: ["result", "results"],
  problem: ["problem", "problems"],
  budget: ["budget alert", "budget alerts"],
};

function summarize(items: InboxItemDto[]): string {
  const counts = new Map<InboxKind, number>();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  // What needs you comes first.
  const order: InboxKind[] = ["approval", "problem", "budget", "result"];
  return order.filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${KIND_WORDS[k][counts.get(k) === 1 ? 0 : 1]}`).join(", ");
}

function digestDue(p: PrefsRow, now: Date): boolean {
  const tz = p.time_zone || "UTC";
  const local = localClock(now, tz);
  if (local.minutes < p.digest_hour * 60) return false;
  if (!p.last_digest_at) return p.email_digest === "daily" || local.weekday === 1;
  const last = localClock(p.last_digest_at, tz);
  if (p.email_digest === "daily") return last.date !== local.date;
  // Weekly: Mondays, once.
  return local.weekday === 1 && last.date !== local.date;
}

function digestEmail(items: InboxItemDto[], name: string, inboxUrl: string, kind: DigestFrequency | "test"): { subject: string; text: string; html: string } {
  const open = items.filter((i) => !i.resolved);
  const subject = kind === "test" ? "Conclave: test email" : `Conclave: ${summarize(items)}`;
  const line = (i: InboxItemDto) => `${i.resolved ? "(done) " : ""}${i.title}${i.path ? ` — ${i.path}` : ""}`;
  const intro =
    kind === "test"
      ? "This is a test. Your email digest will look like this."
      : `Here is your ${kind} summary. ${open.length} of ${items.length} still need${open.length === 1 ? "s" : ""} you.`;
  const text = [`Hi ${name},`, "", intro, "", ...items.map((i) => `- ${line(i)}`), "", `Open your inbox: ${inboxUrl}`, "", "Change how often this comes in Settings > Notifications."].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#1b1b1f;max-width:560px">
<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(intro)}</p>
<ul style="padding-left:18px">${items.map((i) => `<li style="margin:4px 0">${escapeHtml(line(i))}</li>`).join("")}</ul>
<p><a href="${escapeHtml(inboxUrl)}" style="color:#2E5BFF">Open your inbox</a></p>
<p style="color:#6b6b74;font-size:12px">Change how often this comes in Settings &gt; Notifications.</p></div>`;
  return { subject, text, html };
}
