import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const projects = [
  {
    id: "proj_auth",
    kind: "standard" as const,
    name: "identity-service",
    gitRemoteUrl: "https://example.invalid/identity.git",
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "src_auth",
      projectId: "proj_auth",
      type: "local_path" as const,
      hostId: "host_local",
      path: "/repos/identity",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }],
  },
  {
    id: "proj_gateway",
    kind: "standard" as const,
    name: "api-gateway",
    gitRemoteUrl: "https://example.invalid/gateway.git",
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "src_gateway",
      projectId: "proj_gateway",
      type: "local_path" as const,
      hostId: "host_local",
      path: "/repos/gateway",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }],
  },
];

describe("Workspaces plugin server", () => {
  it("creates groups without mutating BB projects", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspaces",
      sdk: { projects: { list: async () => projects } },
      experimental_hostEntry: true,
    });
    await plugin(bb);

    const created = await harness.behavior.callRpc("workspace_create", {
      name: "Authentication",
      description: "Related auth services",
      instructions: "Run contract tests.",
      repositories: [
        { projectId: "proj_auth", alias: "identity" },
        { projectId: "proj_gateway", alias: "gateway" },
      ],
    });
    const dashboard = await harness.behavior.callRpc("dashboard", null) as {
      workspaces: unknown[];
      projects: Array<{ id: string }>;
    };

    expect(created).toMatchObject({ name: "Authentication", revision: 1 });
    expect(dashboard.workspaces).toHaveLength(1);
    expect(dashboard.projects.map((project: { id: string }) => project.id)).toEqual(["proj_auth", "proj_gateway"]);
    expect(harness.inspection.sdk.callsTo("projects.delete")).toHaveLength(0);
  });

  it("prepares selected repos and launches one thread at the common root", async () => {
    const hostCalls: Array<{ method: string; input: unknown }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "workspaces",
      sdk: {
        projects: { list: async () => projects },
        threads: { spawn: async () => makeThreadResponse({ id: "thr_multi", projectId: "proj_auth" }) },
      },
      experimental_hostEntry: true,
      experimental_callHostRpc: async ({ method, input }) => {
        hostCalls.push({ method, input });
        if (method === "cleanup_session") return { cleaned: true };
        if (method !== "prepare_session") throw new Error(`Unexpected host method: ${method}`);
        const request = input as {
          sessionId: string;
          repositories: Array<{ projectId: string; alias: string; sourcePath: string; baseRef: string }>;
        };
        return {
          rootPath: `/plugin-data/sessions/${request.sessionId}`,
          repositories: request.repositories.map((repository) => ({
            ...repository,
            baseCommit: `commit-${repository.alias}`,
            branch: `bb-workspace/${request.sessionId}/${repository.alias}`,
            worktreePath: `/plugin-data/sessions/${request.sessionId}/repos/${repository.alias}`,
          })),
        };
      },
    });
    await plugin(bb);
    const workspace = await harness.behavior.callRpc("workspace_create", {
      name: "Authentication",
      description: "",
      instructions: "Read each repo's AGENTS.md.",
      repositories: [
        { projectId: "proj_auth", alias: "identity" },
        { projectId: "proj_gateway", alias: "gateway" },
      ],
    }) as { id: string; revision: number };

    const session = await harness.behavior.callRpc("session_start", {
      workspaceId: workspace.id,
      expectedRevision: workspace.revision,
      hostId: "host_local",
      projectIds: ["proj_gateway", "proj_auth"],
      prompt: "Change the auth contract in both services.",
      requestKey: "request-auth-contract",
    }) as { id: string; state: string; threadId: string };
    const retried = await harness.behavior.callRpc("session_start", {
      workspaceId: workspace.id,
      expectedRevision: workspace.revision,
      hostId: "host_local",
      projectIds: ["proj_gateway", "proj_auth"],
      prompt: "Change the auth contract in both services.",
      requestKey: "request-auth-contract",
    }) as { id: string };

    expect(session).toMatchObject({
      state: "active",
      threadId: "thr_multi",
      ownerProjectId: "proj_auth",
      rootPath: expect.stringContaining("/sessions/"),
    });
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "proj_auth",
      prompt: "Change the auth contract in both services.",
      title: "🧩 Authentication · Change the auth contract in both services.",
      environment: {
        type: "host",
        hostId: "host_local",
        workspace: { type: "unmanaged", path: expect.stringContaining("/sessions/") },
      },
    });
    expect(retried.id).toBe(session.id);
    expect(hostCalls.filter((call) => call.method === "prepare_session")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);

    await harness.behavior.callRpc("session_archive", { id: session.id });
    const cleaned = await harness.behavior.callRpc("session_cleanup", { id: session.id });
    expect(cleaned).toMatchObject({ state: "cleaned", rootPath: null });
    expect(hostCalls.find((call) => call.method === "cleanup_session")?.input).toMatchObject({
      sessionId: session.id,
      repositories: [
        { projectId: "proj_auth", alias: "identity", baseCommit: "commit-identity" },
        { projectId: "proj_gateway", alias: "gateway", baseCommit: "commit-gateway" },
      ],
    });
  });
});
