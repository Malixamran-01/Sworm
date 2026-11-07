import type { AuthStateDto, MeDto, PermissionName, RoleName, WorkspaceDetailDto } from "@conclave/contract";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const authKey = ["auth"] as const;

/**
 * Switch who is signed in (or sign out with null) without a moment where the
 * app renders with no user: set the auth state first, then drop everything else.
 */
export function replaceSession(qc: QueryClient, me: MeDto | null) {
  qc.setQueryData<AuthStateDto>(authKey, (s) => (s ? { ...s, me } : s));
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== authKey[0] });
}

/** The signed-in person, their org and role. The auth gate guarantees it inside the app. */
export function useMe(): MeDto {
  const state = useQuery({ queryKey: authKey, queryFn: api.authState, staleTime: 60_000 });
  return state.data!.me!;
}

/** Whether the person's org role allows something. The server checks again on every call. */
export function useCan(perm: PermissionName): boolean {
  return useMe().permissions.includes(perm);
}

/** Mirrors the server's role table (ACC-004), for what the UI offers inside a workspace. */
const ROLE_PERMS: Record<RoleName, PermissionName[]> = {
  viewer: ["workspace:read", "connection:read"],
  runner: ["workspace:read", "connection:read", "task:run", "approval:decide"],
  editor: ["workspace:read", "connection:read", "task:run", "approval:decide", "workspace:edit", "connection:manage"],
  owner: ["workspace:read", "connection:read", "task:run", "approval:decide", "workspace:edit", "connection:manage", "member:manage", "org:manage"],
};

/** Whether the person may do something in a workspace, using their effective role there. */
export function useWorkspaceCan(ws: Pick<WorkspaceDetailDto, "yourRole"> | undefined, perm: PermissionName): boolean {
  const me = useMe();
  const role = ws?.yourRole ?? me.role;
  // A token's scopes still narrow what the org role allows.
  return ROLE_PERMS[role].includes(perm) && (me.via === "session" || me.permissions.includes(perm));
}
