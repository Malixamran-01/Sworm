import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Navigate, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionsPage } from "./features/connections/ConnectionsPage";
import { HomePage } from "./features/home/HomePage";
import { InboxPage } from "./features/inbox/InboxPage";
import { InsightsPage } from "./features/insights/InsightsPage";
import { TracePage } from "./features/workspaces/tasks/TracePage";
import { ActivityTab } from "./features/workspaces/activity/ActivityTab";
import { LibraryTab } from "./features/workspaces/library/LibraryTab";
import { NewWorkspacePage } from "./features/workspaces/NewWorkspacePage";
import { SettingsTab } from "./features/workspaces/settings/SettingsTab";
import { TasksTab } from "./features/workspaces/tasks/TasksTab";
import { TeamTab } from "./features/workspaces/team/TeamTab";
import { WorkflowEditor } from "./features/workspaces/workflows/editor/WorkflowEditor";
import { WorkflowsTab } from "./features/workspaces/workflows/WorkflowsTab";
import { WorkspaceLayout } from "./features/workspaces/WorkspaceLayout";
import { realtime } from "./lib/realtime";
import "./lib/theme";
import { AuthGate } from "./shell/AuthGate";
import { SettingsPage } from "./features/settings/SettingsPage";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 } },
});
realtime.attach(queryClient);

const root = createRootRoute({ component: AuthGate });
const workspace = createRoute({ getParentRoute: () => root, path: "/workspaces/$workspaceId", component: WorkspaceLayout });
const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: "/", component: HomePage }),
  createRoute({ getParentRoute: () => root, path: "/inbox", component: InboxPage }),
  createRoute({ getParentRoute: () => root, path: "/connections", component: ConnectionsPage }),
  createRoute({ getParentRoute: () => root, path: "/insights", component: InsightsPage }),
  createRoute({ getParentRoute: () => root, path: "/workspaces/new", component: NewWorkspacePage }),
  createRoute({ getParentRoute: () => root, path: "/settings", component: SettingsPage }),
  // Signed-in visitors to these land on Home; the auth gate shows them otherwise.
  createRoute({ getParentRoute: () => root, path: "/sign-in", component: () => <Navigate to="/" /> }),
  createRoute({ getParentRoute: () => root, path: "/invite/$token", component: () => <Navigate to="/" /> }),
  workspace.addChildren([
    createRoute({ getParentRoute: () => workspace, path: "/", component: TasksTab }),
    createRoute({ getParentRoute: () => workspace, path: "/tasks/$taskId", component: TasksTab }),
    createRoute({ getParentRoute: () => workspace, path: "/tasks/$taskId/trace", component: TracePage }),
    createRoute({ getParentRoute: () => workspace, path: "/team", component: TeamTab }),
    createRoute({ getParentRoute: () => workspace, path: "/workflows", component: WorkflowsTab }),
    createRoute({ getParentRoute: () => workspace, path: "/workflows/$key", component: WorkflowEditor }),
    createRoute({ getParentRoute: () => workspace, path: "/library", component: LibraryTab }),
    createRoute({ getParentRoute: () => workspace, path: "/activity", component: ActivityTab }),
    createRoute({ getParentRoute: () => workspace, path: "/settings", component: SettingsTab }),
  ]),
]);

const router = createRouter({ routeTree, defaultPreload: "intent" });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
