import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { addTarget, bridgeHome, loadDevice, loadTargets, pair, removeTarget, runBridge } from "./index";

const HELP = `Conclave Local Bridge

  conclave-bridge pair <server-url> [--name <device name>]
      Pair this computer. Shows a code to enter in Conclave (Settings > Devices),
      then asks you here to confirm who claimed it.

  conclave-bridge target add <name> --stdio "<command>" [--egress host1,host2]
      A module this computer starts and talks to over stdio. It may reach only
      the hosts listed.
  conclave-bridge target add <name> --http <http://127.0.0.1:port/cmp> [--secret-env VAR]
      A module or app already listening on this computer.
  conclave-bridge target list
  conclave-bridge target remove <name>

  conclave-bridge run       Connect and serve calls until stopped (Ctrl+C).
  conclave-bridge status    Show the pairing and targets.

Nothing on this computer is reachable until you add it as a target here.
Files live in ${bridgeHome()} (set CONCLAVE_BRIDGE_HOME to change it).`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const [command, sub, name] = args;
  switch (command) {
    case "pair": {
      if (!sub) throw new Error("Give the server URL, like: conclave-bridge pair https://conclave.example.com");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const device = await pair(sub, flag("name") ?? hostname(), {
          showCode: (code) => console.log(`\nIn Conclave, open Settings > Devices > Pair a device, and enter:\n\n    ${code}\n\nWaiting (the code works for 10 minutes)…`),
          confirm: async (who) => {
            const answer = await rl.question(`\n${who.name} <${who.email}> in "${who.org}" entered the code.\nAllow them to use the targets you add on this computer? [y/N] `);
            return /^y(es)?$/i.test(answer.trim());
          },
        });
        console.log(`\nPaired as "${device.name}". Add a target, then run: conclave-bridge run`);
      } finally {
        rl.close();
      }
      return;
    }
    case "target": {
      if (sub === "list") {
        const targets = loadTargets();
        if (!targets.length) console.log("No targets yet. Nothing on this computer is reachable.");
        for (const t of targets) console.log(`${t.name}  ${t.kind === "stdio" ? `stdio: ${t.command}${t.egress.length ? `  (may reach ${t.egress.join(", ")})` : "  (no network)"}` : `http: ${t.url}`}`);
        return;
      }
      if (sub === "remove") {
        if (!name) throw new Error("Which target?");
        console.log(removeTarget(name) ? `Removed ${name}.` : `No target called ${name}.`);
        return;
      }
      if (sub === "add") {
        if (!name) throw new Error("Give the target a name.");
        const stdio = flag("stdio");
        const http = flag("http");
        if (!!stdio === !!http) throw new Error("Use one of --stdio or --http.");
        const egress = (flag("egress") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
        const secretEnv = flag("secret-env");
        const target = stdio ? addTarget({ name, kind: "stdio", command: stdio, egress }) : addTarget({ name, kind: "http", url: http!, ...(secretEnv ? { secretEnv } : {}) });
        console.log(`Added ${target.name}. In Conclave, add a "Local Bridge target" connection with this device and target "${target.name}".`);
        return;
      }
      throw new Error("Use target add, target list or target remove.");
    }
    case "run": {
      const controller = new AbortController();
      process.on("SIGINT", () => controller.abort());
      process.on("SIGTERM", () => controller.abort());
      await runBridge({ signal: controller.signal });
      return;
    }
    case "status": {
      const device = loadDevice();
      console.log(device ? `Paired with ${device.server} as "${device.name}" (${device.deviceId}).` : "Not paired.");
      console.log(`${loadTargets().length} target(s).`);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
