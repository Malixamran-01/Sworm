import { createHash } from "node:crypto";
import type { CmpErrorBody } from "./cmp";

/**
 * The Local Bridge wire protocol (SRS 8.8), shared by the server and the
 * bridge on the user's machine. The bridge opens one outbound WebSocket and
 * never listens on a port. The server sends CMP calls for a named target;
 * each call is signed with the server's Ed25519 key, which the bridge pinned
 * when it paired, and the bridge checks it against its own local targets.
 */

export interface BridgeTargetInfo {
  name: string;
  kind: "stdio" | "http";
}

export type BridgeServerMessage =
  | { type: "challenge"; nonce: string }
  | { type: "ready"; device: { id: string; name: string } }
  /** params is the JSON text that was signed, parsed by the bridge after it checks the signature. */
  | { type: "call"; id: number; target: string; method: string; params: string; ts: string; sig: string }
  | { type: "cancel"; id: number };

export type BridgeDeviceMessage =
  | { type: "hello"; deviceId: string; sig: string; targets: BridgeTargetInfo[] }
  | { type: "targets"; targets: BridgeTargetInfo[] }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; error: CmpErrorBody };

/** What the server signs for each call; the bridge rebuilds it to check the signature. */
export function bridgeCallMessage(id: number, deviceId: string, target: string, method: string, ts: string, params: string): string {
  return `call:${id}:${deviceId}:${target}:${method}:${ts}:${createHash("sha256").update(params).digest("hex")}`;
}

/** Methods a bridge passes on to a target: CMP's host-to-module calls, nothing else. */
export const BRIDGE_METHODS = new Set([
  "initialize",
  "health",
  "outsideVersion",
  "discover",
  "model.listModels",
  "model.generate",
  "tool.listTools",
  "tool.call",
  "agent.listSkills",
  "agent.startRun",
  "agent.events",
  "agent.provideInput",
  "agent.cancel",
  "workflow.list",
  "workflow.trigger",
  "workflow.poll",
  "workflow.callback",
  "workflow.cancel",
  "knowledge.listSources",
  "knowledge.search",
]);
