// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const project = {
  id: "proj_auth",
  name: "identity-service",
  gitRemoteUrl: "https://example.invalid/identity.git",
  sources: [{ id: "src_auth", hostId: "host_local", path: "/repos/identity", isDefault: true }],
};

const gatewayProject = {
  id: "proj_gateway",
  name: "api-gateway",
  gitRemoteUrl: "https://example.invalid/gateway.git",
  sources: [{ id: "src_gateway", hostId: "host_local", path: "/repos/gateway", isDefault: true }],
};

const workspace = {
  id: "ws_auth",
  name: "Authentication",
  description: "",
  instructions: "",
  revision: 1,
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  repositories: [
    { projectId: "proj_auth", alias: "identity", ordinal: 0 },
    { projectId: "proj_gateway", alias: "gateway", ordinal: 1 },
  ],
};

const activeSession = {
  id: "session_auth",
  workspaceId: "ws_auth",
  workspaceName: "Authentication",
  workspaceRevision: 1,
  instructions: "",
  repositories: [{ projectId: "proj_auth", alias: "identity", branch: "workspace/identity", worktreePath: "/worktrees/identity" }],
  initialRepositories: [{ projectId: "proj_auth", alias: "identity" }],
  expansionPolicy: "ask" as const,
  expansions: [],
  manifestRevision: 1,
  state: "active" as const,
  hostId: "host_local",
  rootPath: "/worktrees",
  ownerProjectId: "proj_auth",
  threadId: "thr_auth",
  error: null,
  createdAt: 1,
  updatedAt: 1,
};

const expansionOption = {
  projectId: "proj_gateway",
  alias: "gateway",
  projectName: "api-gateway",
  sourcePath: "/repos/gateway",
};

const billingOption = {
  projectId: "proj_billing",
  alias: "billing",
  projectName: "billing-service",
  sourcePath: "/repos/billing",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("repository approval interaction", () => {
  const validPayload = {
    sessionId: "session_auth",
    workspaceName: "Authentication",
    repositoryAlias: "gateway",
    repositoryName: "api-gateway",
    reason: "The task needs gateway routes.",
  };

  it.each([
    ["Add this repo", { action: "add-once" }],
    ["Add and auto-approve more", { action: "add-and-auto" }],
    ["Cancel", { action: "cancel" }],
  ])("submits %s from a validated approval request", async (label, expected) => {
    const app = await loadPluginApp(() => import("../app"));
    const submissions: unknown[] = [];
    const slot = renderSlot(app.pendingInteractions.find((registration) => registration.id === "workspace-add-repository")!, {
      interaction: { id: "approval-1", threadId: "thr_auth", title: "Add repository", payload: validPayload, createdAt: 1, expiresAt: null },
      submit: async (value: unknown) => { submissions.push(value); },
      cancel: async () => {},
    });

    expect(await slot.findByText("Workspace: Authentication")).toBeTruthy();
    expect(slot.getByText("Repository: gateway")).toBeTruthy();
    expect(slot.getByText("The task needs gateway routes.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: label }));

    await expect.poll(() => submissions).toContainEqual(expected);
    slot.lifecycle.unmount();
  });

  it("rejects malformed approval payloads and only offers safe host cancellation", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const submissions: unknown[] = [];
    let cancellations = 0;
    const slot = renderSlot(app.pendingInteractions.find((registration) => registration.id === "workspace-add-repository")!, {
      interaction: { id: "approval-invalid", threadId: "thr_auth", title: "Add repository", payload: { workspaceName: "spoofed" }, createdAt: 1, expiresAt: null },
      submit: async (value: unknown) => { submissions.push(value); },
      cancel: async () => { cancellations += 1; },
    });

    expect(await slot.findByRole("alert")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Add this repo" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Add and auto-approve more" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));

    await expect.poll(() => cancellations).toBe(1);
    expect(submissions).toEqual([]);
    slot.lifecycle.unmount();
  });

  it.each([
    ["submit", validPayload, "Add this repo"],
    ["cancel", { workspaceName: "malformed" }, "Cancel"],
  ])("does not let stale %s completion overwrite a replacement interaction", async (kind, payload, buttonName) => {
    const app = await loadPluginApp(() => import("../app"));
    const approval = app.pendingInteractions.find((registration) => registration.id === "workspace-add-repository")!;
    const stale = deferred<void>();
    const current = deferred<void>();
    const slot = renderSlot(approval, {
      interaction: { id: "approval-a", threadId: "thr_auth", title: "Add repository", payload, createdAt: 1, expiresAt: null },
      submit: async () => kind === "submit" ? stale.promise : undefined,
      cancel: async () => kind === "cancel" ? stale.promise : undefined,
    });

    fireEvent.click(await slot.findByRole("button", { name: buttonName }));
    const Approval = approval.component;
    slot.lifecycle.rerender(<Approval interaction={{ id: "approval-b", threadId: "thr_auth", title: "Add repository", payload: validPayload, createdAt: 2, expiresAt: null }} submit={async () => current.promise} cancel={async () => {}} />);
    fireEvent.click(await slot.findByRole("button", { name: "Add and auto-approve more" }));
    expect(slot.getByRole("button", { name: "Add and auto-approve more" }).hasAttribute("disabled")).toBe(true);

    await act(async () => { stale.reject(new Error("stale completion")); await stale.promise.catch(() => {}); });
    expect(slot.queryByRole("alert")).toBeNull();
    expect(slot.getByRole("button", { name: "Add and auto-approve more" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { current.resolve(); await current.promise; });
    slot.lifecycle.unmount();
  });
});

describe("Workspaces page", () => {
  beforeEach(() => globalThis.localStorage.clear());

  it("creates a workspace from selected BB projects", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        dashboard: () => ({ workspaces: [], sessions: [], projects: [project] }),
        workspace_create: (input: unknown) => {
          calls.push(input);
          return { id: "ws_auth", revision: 1 };
        },
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: /new workspace/i }));
    expect(await slot.findByRole("dialog", { name: /create workspace/i })).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Workspace name"), { target: { value: "Authentication" } });
    fireEvent.click(slot.getByRole("checkbox", { name: /identity-service/i }));
    fireEvent.click(slot.getByRole("button", { name: /create workspace/i }));

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({
      name: "Authentication",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "identity-service" }],
    });
    slot.lifecycle.unmount();
  });

  it("selects every workspace repository initially and remembers a changed subset", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const rpc = {
      dashboard: () => ({ workspaces: [workspace], sessions: [], projects: [project, gatewayProject] }),
    };
    const first = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });

    const identity = await first.findByRole("checkbox", { name: "Use identity-service" });
    const gateway = first.getByRole("checkbox", { name: "Use api-gateway" });
    expect(identity.getAttribute("data-state")).toBe("checked");
    expect(gateway.getAttribute("data-state")).toBe("checked");
    expect(first.queryByText("Primary repository")).toBeNull();
    fireEvent.click(gateway);
    expect(gateway.getAttribute("data-state")).toBe("unchecked");
    first.lifecycle.unmount();

    const reopened = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
    expect((await reopened.findByRole("checkbox", { name: "Use identity-service" })).getAttribute("data-state")).toBe("checked");
    expect(reopened.getByRole("checkbox", { name: "Use api-gateway" }).getAttribute("data-state")).toBe("unchecked");
    reopened.lifecycle.unmount();
  });
});

describe("Repositories panel", () => {
  it("adds a trusted eligible repository once and refreshes the displayed session", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const additions: Array<{ threadId: string; projectId: string; requestKey: string }> = [];
    let dashboardCalls = 0;
    const addedSession = { ...activeSession, repositories: [...activeSession.repositories, { projectId: "proj_gateway", alias: "gateway", branch: "workspace/gateway", worktreePath: "/worktrees/gateway" }] };
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [dashboardCalls++ < 1 ? activeSession : addedSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: activeSession, repositories: [expansionOption] }),
        session_add_repository: (input: unknown) => {
          additions.push(input as { threadId: string; projectId: string; requestKey: string });
          return { added: true, alias: "gateway", worktreePath: "/worktrees/gateway", policy: "ask", session: addedSession };
        },
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    const select = await slot.findByLabelText("Repository to add");
    fireEvent.change(select, { target: { value: "proj_gateway" } });
    fireEvent.click(slot.getByRole("button", { name: "Add selected repository" }));

    await expect.poll(() => additions).toHaveLength(1);
    expect(additions[0]).toMatchObject({ threadId: "thr_auth", projectId: "proj_gateway" });
    expect(additions[0]!.requestKey).toMatch(/^manual-/);
    expect(await slot.findByText("gateway")).toBeTruthy();
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "dashboard").length).toBeGreaterThan(1);
    slot.lifecycle.unmount();
  });

  it("keeps its request key for a retry and disables duplicate submissions while pending", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const additions: Array<{ threadId: string; projectId: string; requestKey: string }> = [];
    let attempt = 0;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: activeSession, repositories: [expansionOption] }),
        session_add_repository: async (input: unknown) => {
          additions.push(input as { threadId: string; projectId: string; requestKey: string });
          if (attempt++ === 0) throw new Error("Temporary host error");
          return { added: true, alias: "gateway", worktreePath: "/worktrees/gateway", policy: "ask", session: activeSession };
        },
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    fireEvent.change(await slot.findByLabelText("Repository to add"), { target: { value: "proj_gateway" } });
    const addButton = slot.getByRole("button", { name: "Add selected repository" });
    fireEvent.click(addButton);
    expect(addButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(addButton);

    await expect.poll(() => additions).toHaveLength(1);
    expect((await slot.findByRole("alert")).textContent).toContain("Temporary host error");
    fireEvent.click(slot.getByRole("button", { name: "Add selected repository" }));
    await expect.poll(() => additions).toHaveLength(2);
    expect(additions[1]!.requestKey).toBe(additions[0]!.requestKey);
    slot.lifecycle.unmount();
  });

  it("reloads eligible repositories after workspace changes and explains exhausted options", async () => {
    const app = await loadPluginApp(() => import("../app"));
    let optionCalls = 0;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: activeSession, repositories: optionCalls++ === 0 ? [expansionOption] : [] }),
      },
    });

    expect(await slot.findByRole("button", { name: "Add repository" })).toBeTruthy();
    await slot.behavior.emitRealtime("workspaces-changed", { at: 2 });
    expect(await slot.findByText("All current workspace repositories are already available.")).toBeTruthy();
    expect(slot.getByText("Editing this workspace changes future repository eligibility; it does not change this session.")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("keeps only the latest thread's overlapping option response", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.threadPanelActions[0]!;
    const first = deferred<{ session: typeof activeSession; repositories: typeof expansionOption[] }>();
    const secondSession = { ...activeSession, id: "session_billing", threadId: "thr_billing" };
    const second = deferred<{ session: typeof secondSession; repositories: typeof billingOption[] }>();
    const calls: string[] = [];
    const slot = renderSlot(panel, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession, secondSession], projects: [project, gatewayProject] }),
        session_expansion_options: (input: unknown) => {
          const threadId = (input as { threadId: string }).threadId;
          calls.push(threadId);
          return threadId === "thr_auth" ? first.promise : second.promise;
        },
      },
    });

    await expect.poll(() => calls).toEqual(["thr_auth"]);
    const Panel = panel.component;
    slot.lifecycle.rerender(<Panel threadId="thr_billing" params={null} />);
    await expect.poll(() => calls).toEqual(["thr_auth", "thr_billing"]);
    await act(async () => { second.resolve({ session: secondSession, repositories: [billingOption] }); await second.promise; });
    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    expect((await slot.findByLabelText("Repository to add") as HTMLSelectElement).value).toBe("proj_billing");
    await act(async () => { first.resolve({ session: activeSession, repositories: [expansionOption] }); await first.promise; });
    expect((slot.getByLabelText("Repository to add") as HTMLSelectElement).value).toBe("proj_billing");
    slot.lifecycle.unmount();
  });

  it("closes an open form when realtime removes its selected option", async () => {
    const app = await loadPluginApp(() => import("../app"));
    let repositories = [expansionOption, billingOption];
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: activeSession, repositories }),
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    fireEvent.change(await slot.findByLabelText("Repository to add"), { target: { value: "proj_billing" } });
    repositories = [expansionOption];
    await slot.behavior.emitRealtime("workspaces-changed", { at: 3 });
    await expect.poll(() => slot.queryByLabelText("Repository to add")).toBeNull();
    expect(slot.getByRole("button", { name: "Add repository" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("closes and disables manual addition when latest options report an inactive session", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const inactiveSession = { ...activeSession, state: "archived" as const };
    let latestSession: typeof activeSession | typeof inactiveSession = activeSession;
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_auth", params: null }, {
      rpc: {
        dashboard: () => ({ workspaces: [workspace], sessions: [activeSession], projects: [project, gatewayProject] }),
        session_expansion_options: () => ({ session: latestSession, repositories: [expansionOption] }),
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add repository" }));
    expect(await slot.findByLabelText("Repository to add")).toBeTruthy();
    latestSession = inactiveSession;
    await slot.behavior.emitRealtime("workspaces-changed", { at: 4 });
    await expect.poll(() => slot.queryByLabelText("Repository to add")).toBeNull();
    expect(slot.queryByRole("button", { name: "Add repository" })).toBeNull();
    latestSession = activeSession;
    await slot.behavior.emitRealtime("workspaces-changed", { at: 5 });
    expect(await slot.findByRole("button", { name: "Add repository" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
