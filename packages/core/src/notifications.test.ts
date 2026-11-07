import { newId, type EventEnvelope, type InboxKind } from "@conclave/contract";
import { createECDH, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { inQuietHours, localClock, type MailMessage } from "./notifications";
import { harness, type Harness } from "./test-helpers";

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

/** A fake browser push service and mailbox, plus a clock the test moves. */
function rig(start = "2026-11-06T12:00:00Z") {
  const pushes: { url: string; headers: Record<string, string>; bytes: number }[] = [];
  const mail: MailMessage[] = [];
  const clock = { now: new Date(start) };
  let status = 201;
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    pushes.push({ url: String(url), headers: init?.headers as Record<string, string>, bytes: (init?.body as Uint8Array | undefined)?.byteLength ?? 0 });
    return new Response(null, { status });
  }) as typeof fetch;
  return {
    pushes,
    mail,
    clock,
    setStatus: (s: number) => (status = s),
    options: {
      notifications: {
        fetch: fakeFetch,
        now: () => clock.now,
        publicUrl: "https://conclave.example.test",
        mailer: { send: async (m: MailMessage) => void mail.push(m) },
      },
    },
  };
}

/** A real-shaped browser subscription: a P-256 public key and a 16-byte auth secret. */
function browserSubscription(endpoint = `https://fcm.googleapis.com/fcm/send/${newId()}`) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

async function addItem(h: Harness, kind: InboxKind, opts: { urgent?: boolean; resolved?: boolean; workspaceId?: string; at?: Date } = {}) {
  const id = newId();
  await h.conclave.db.query(
    `insert into inbox_items (id, org_id, user_id, workspace_id, kind, title, body, path, urgent, resolved, created_at)
     values ($1, $2, $3, $4, $5, $6, 'Body', 'Research Brief > Task', $7, $8, $9)`,
    [id, h.actor.orgId, h.actor.userId, opts.workspaceId ?? h.workspaceId, kind, `${kind} ${id.slice(-4)}`, opts.urgent ?? false, opts.resolved ?? false, opts.at ?? new Date()],
  );
  return id;
}

const delivery = async (h: Harness, id: string) =>
  (await h.conclave.db.query<{ delivery: string }>(`select delivery from inbox_items where id = $1`, [id]))[0]!.delivery;

function desktopEvents(h: Harness) {
  const seen: EventEnvelope[] = [];
  h.conclave.bus.subscribe("*", (e) => e.event.type === "notification" && seen.push(e));
  return seen;
}

describe("Quiet hours (NOTE-004)", () => {
  it("reads local time in the person's zone, including windows across midnight", () => {
    const at = new Date("2026-11-06T23:30:00Z");
    expect(localClock(at, "Asia/Kolkata")).toMatchObject({ minutes: 5 * 60, date: "2026-11-07" });
    const night = { quiet_start: 22 * 60, quiet_end: 7 * 60, time_zone: "UTC" };
    expect(inQuietHours(night, at)).toBe(true);
    expect(inQuietHours(night, new Date("2026-11-06T07:00:00Z"))).toBe(false);
    expect(inQuietHours(night, new Date("2026-11-06T06:59:00Z"))).toBe(true);
    expect(inQuietHours({ quiet_start: 9 * 60, quiet_end: 17 * 60, time_zone: "UTC" }, new Date("2026-11-06T12:00:00Z"))).toBe(true);
    expect(inQuietHours({ quiet_start: null, quiet_end: null, time_zone: "UTC" }, at)).toBe(false);
  });

  it("holds ordinary items, still delivers a safety check, then releases the rest when quiet hours end", async () => {
    const r = rig("2026-11-06T23:00:00Z");
    h = await harness(r.options);
    const desktop = desktopEvents(h);
    await h.conclave.notifier.subscribe(h.actor, browserSubscription());
    await h.conclave.notifier.updatePrefs(h.actor, { quietStart: 22 * 60, quietEnd: 7 * 60, timeZone: "UTC" });
    expect((await h.conclave.notifier.settings(h.actor)).quietNow).toBe(true);

    const ordinary = await addItem(h, "result");
    const safety = await addItem(h, "approval", { urgent: true });
    const report = await h.conclave.notifier.deliverPending();
    await h.conclave.relay.drain();
    expect(report).toMatchObject({ sent: 1, held: 1, pushes: 1 });
    expect(await delivery(h, ordinary)).toBe("held");
    expect(await delivery(h, safety)).toBe("sent");
    expect(desktop.map((e) => e.event.type === "notification" && e.event.item.id)).toEqual([safety]);
    expect(r.pushes[0]!.headers).toMatchObject({ Urgency: "high" });

    r.clock.now = new Date("2026-11-07T07:05:00Z");
    expect(await h.conclave.notifier.deliverPending()).toMatchObject({ sent: 1, held: 0 });
    expect(await delivery(h, ordinary)).toBe("sent");
    expect(r.pushes).toHaveLength(2);
  });
});

describe("Delivery (NOTE-003)", () => {
  it("sends an approval from a real run as a desktop notification and an encrypted web push", async () => {
    const r = rig();
    h = await harness(r.options);
    const desktop = desktopEvents(h);
    await h.conclave.notifier.subscribe(h.actor, browserSubscription());
    await h.conclave.orchestrator.start(h.actor, { workspaceId: h.workspaceId, taskTypeId: h.taskTypeId, brief: { topic: "Heat pumps" } });
    await h.settle();

    expect(await h.conclave.notifier.deliverPending()).toMatchObject({ sent: 1, pushes: 1 });
    await h.conclave.relay.drain();
    const event = desktop[0]!.event;
    expect(event.type === "notification" && event.item.kind).toBe("approval");

    const push = r.pushes[0]!;
    expect(push.url).toMatch(/^https:\/\/fcm\.googleapis\.com\//);
    expect(push.headers).toMatchObject({ "Content-Encoding": "aes128gcm" });
    expect(push.headers.Authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(push.bytes).toBeGreaterThan(0);

    // Delivered once only.
    expect(await h.conclave.notifier.deliverPending()).toMatchObject({ sent: 0 });
    expect(r.pushes).toHaveLength(1);
  });

  it("follows per-workspace alert rules; muted items stay in the inbox", async () => {
    const r = rig();
    h = await harness(r.options);
    await h.conclave.notifier.subscribe(h.actor, browserSubscription());
    await h.conclave.notifier.setRule(h.actor, h.workspaceId, "important");
    const result = await addItem(h, "result");
    const approval = await addItem(h, "approval");
    expect(await h.conclave.notifier.deliverPending()).toMatchObject({ sent: 1, muted: 1 });
    expect(await delivery(h, result)).toBe("muted");
    expect(await delivery(h, approval)).toBe("sent");

    await h.conclave.notifier.setRule(h.actor, h.workspaceId, "none");
    await addItem(h, "problem");
    expect(await h.conclave.notifier.deliverPending()).toMatchObject({ sent: 0, muted: 1 });
    expect((await h.conclave.orchestrator.inbox(h.actor)).length).toBeGreaterThanOrEqual(3);
    expect((await h.conclave.notifier.settings(h.actor)).rules).toEqual([{ workspaceId: h.workspaceId, workspaceName: "Research Brief", level: "none" }]);

    await h.conclave.notifier.setRule(h.actor, h.workspaceId, "all");
    expect((await h.conclave.notifier.settings(h.actor)).rules).toEqual([]);
  });

  it("does not ring for items already handled, and sums up a pile in one push", async () => {
    const r = rig();
    h = await harness(r.options);
    await h.conclave.notifier.subscribe(h.actor, browserSubscription());
    const handled = await addItem(h, "approval", { resolved: true });
    for (let i = 0; i < 5; i++) await addItem(h, "result");
    expect(await h.conclave.notifier.deliverPending()).toMatchObject({ sent: 5, pushes: 1 });
    expect(await delivery(h, handled)).toBe("skipped");
  });

  it("only pushes to browser push services, and forgets subscriptions the browser dropped", async () => {
    const r = rig();
    h = await harness(r.options);
    await expect(h.conclave.notifier.subscribe(h.actor, browserSubscription("https://10.0.0.5/push"))).rejects.toThrow(/browser push service/);
    await expect(h.conclave.notifier.subscribe(h.actor, browserSubscription("http://fcm.googleapis.com/x"))).rejects.toThrow(/browser push service/);

    const settings = await h.conclave.notifier.subscribe(h.actor, browserSubscription());
    expect(settings.prefs.push).toBe(true);
    expect(settings.pushDevices).toHaveLength(1);
    expect(settings.server.pushPublicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);

    r.setStatus(410);
    await addItem(h, "result");
    await h.conclave.notifier.deliverPending();
    expect((await h.conclave.notifier.settings(h.actor)).pushDevices).toHaveLength(0);
  });

  it("keeps the VAPID private key in the vault, not in plain text", async () => {
    h = await harness(rig().options);
    const key = await h.conclave.notifier.pushPublicKey(h.actor.orgId);
    expect(await h.conclave.notifier.pushPublicKey(h.actor.orgId)).toBe(key);
    const [row] = await h.conclave.db.query<Record<string, unknown>>(`select * from push_keys`);
    expect(Object.keys(row!).sort()).toEqual(["org_id", "public_key", "secret_id"]);
  });
});

describe("Email digest (NOTE-003)", () => {
  it("sends a daily digest at the chosen local hour, once, with what came in", async () => {
    const r = rig("2026-11-06T02:00:00Z"); // 07:30 in Kolkata
    h = await harness(r.options);
    await h.conclave.notifier.updatePrefs(h.actor, { emailDigest: "daily", digestHour: 8, timeZone: "Asia/Kolkata" });
    await addItem(h, "approval");
    await addItem(h, "result");

    expect(await h.conclave.notifier.sendDigests()).toBe(0); // before 08:00 local
    r.clock.now = new Date("2026-11-06T02:45:00Z"); // 08:15 local
    expect(await h.conclave.notifier.sendDigests()).toBe(1);
    expect(await h.conclave.notifier.sendDigests()).toBe(0);

    const m = r.mail[0]!;
    expect(m.to).toBe("owner@localhost");
    expect(m.subject).toBe("Conclave: 1 approval waiting, 1 result");
    expect(m.text).toContain("https://conclave.example.test/inbox");
    expect(m.html).not.toContain("<script");

    // Next day, only what is new.
    r.clock.now = new Date("2026-11-07T03:00:00Z");
    await addItem(h, "problem", { at: new Date("2026-11-06T20:00:00Z") });
    expect(await h.conclave.notifier.sendDigests()).toBe(1);
    expect(r.mail[1]!.subject).toBe("Conclave: 1 problem");
  });

  it("refuses digests when the server has no email set up", async () => {
    h = await harness({ notifications: {} });
    await expect(h.conclave.notifier.updatePrefs(h.actor, { emailDigest: "daily" })).rejects.toThrow(/no email/);
    await expect(h.conclave.notifier.updatePrefs(h.actor, { timeZone: "Mars/Olympus" })).rejects.toThrow(/time zone/);
    await expect(h.conclave.notifier.updatePrefs(h.actor, { quietStart: 60 })).rejects.toThrow(/start and an end/);
  });
});
