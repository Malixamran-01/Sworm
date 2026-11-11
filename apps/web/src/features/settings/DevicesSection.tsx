import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { ago } from "../../lib/format";
import { Button, Card, ErrorNote, Field, Input, Pill } from "../../ui";

/**
 * Local Bridge devices (SRS 8.8): computers that let this server use modules
 * and apps on them. Nothing on a computer is reachable until its person adds
 * it there as a target.
 */
export function DevicesSection() {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 15_000 });
  const [code, setCode] = useState("");
  const claim = useMutation({
    mutationFn: () => api.claimDevice(code.trim()),
    onSuccess: () => {
      setCode("");
      void qc.invalidateQueries({ queryKey: ["devices"] });
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.removeDevice(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ["devices"] }) });

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <Card as="section" className="flex flex-col gap-3 p-5" aria-labelledby="pair-title">
        <h2 id="pair-title" className="m-0 text-base font-semibold">
          Pair a device
        </h2>
        <p className="m-0 text-[13px] text-muted">
          On the computer, run <code className="text-[12px]">conclave-bridge pair {location.origin}</code>. It shows a code; enter it here, then confirm on the computer.
        </p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) claim.mutate();
          }}
        >
          <Field label="Code from the device" htmlFor="device-code">
            <Input id="device-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoComplete="off" className="w-40 font-mono tracking-wider" />
          </Field>
          <Button type="submit" variant="primary" disabled={!code.trim() || claim.isPending}>
            Pair
          </Button>
        </form>
        {claim.data ? (
          <p role="status" className="m-0 text-[13px] font-semibold text-good">
            Now confirm on “{claim.data.name}”. It appears below once confirmed.
          </p>
        ) : null}
        <ErrorNote error={claim.error} />
      </Card>

      <Card as="section" className="flex flex-col gap-3 p-5" aria-labelledby="devices-title">
        <h2 id="devices-title" className="m-0 text-base font-semibold">
          Paired devices
        </h2>
        {devices.error ? <ErrorNote error={devices.error} /> : null}
        {devices.data?.length === 0 ? <p className="m-0 text-[13px] text-muted">None yet.</p> : null}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {devices.data?.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {d.name} {d.online ? <Pill tone="good">Online</Pill> : <Pill>Offline</Pill>}
                </span>
                <span className="text-xs text-muted">
                  {d.targets.length ? `Targets: ${d.targets.map((t) => t.name).join(", ")}` : d.online ? "No targets added on it yet" : `Last seen ${d.lastSeenAt ? ago(d.lastSeenAt) : "never"}`}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="!text-bad"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirm(`Remove ${d.name}? This server can no longer reach it until it is paired again.`)) remove.mutate(d.id);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <ErrorNote error={remove.error} />
      </Card>

      <Card as="section" className="flex flex-col gap-2 p-5" aria-labelledby="targets-title">
        <h2 id="targets-title" className="m-0 text-base font-semibold">
          Adding targets on a device
        </h2>
        <p className="m-0 text-[13px] text-muted">Only the person at the computer can add a target; this server cannot. Then add a “Local Bridge target” connection with the device and target name.</p>
        {/* Long commands scroll sideways on a phone, so the block takes keyboard focus. */}
        <pre tabIndex={0} aria-label="Commands to run on the device" className="m-0 overflow-x-auto rounded-lg bg-sunken p-3 text-[12px] focus-visible:outline-2 focus-visible:outline-accent">

          {`conclave-bridge target add my-agent --stdio "node agent.js" --egress api.example.com
conclave-bridge target add local-app --http http://127.0.0.1:8642/cmp --secret-env APP_SECRET
conclave-bridge run`}
        </pre>
      </Card>
    </div>
  );
}
