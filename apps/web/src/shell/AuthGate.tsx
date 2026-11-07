import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { InvitePage, SetupPage, SignInPage } from "../features/auth/AuthScreens";
import { api, setSignedOutHandler } from "../lib/api";
import { authKey } from "../lib/auth";
import { realtime } from "../lib/realtime";
import { ErrorNote } from "../ui";
import { AppShell } from "./AppShell";

/** Shows setup, sign-in or an invite until someone is signed in, then the app. */
export function AuthGate() {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: authKey, queryFn: api.authState, staleTime: 60_000 });
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setSignedOutHandler(() => void qc.invalidateQueries({ queryKey: authKey }));
  }, [qc]);

  // Live updates need a session, so the socket follows sign-in and sign-out.
  const signedIn = !!state.data?.me;
  useEffect(() => {
    if (signedIn) realtime.start();
    else realtime.stop();
  }, [signedIn]);

  if (state.isLoading) return null;
  if (state.error || !state.data) {
    return (
      <main className="mx-auto max-w-md px-4 py-20">
        <ErrorNote error={state.error ?? new Error("Could not reach the server.")} />
      </main>
    );
  }
  const invite = /^\/invite\/([^/]+)/.exec(pathname)?.[1];
  if (invite) return <InvitePage token={decodeURIComponent(invite)} state={state.data} />;
  if (state.data.setupRequired) return <SetupPage state={state.data} />;
  if (!state.data.me) return <SignInPage state={state.data} />;
  return <AppShell />;
}
