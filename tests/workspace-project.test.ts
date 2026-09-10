import { describe, expect, it } from "vitest";
import {
  ensureWorkspaceProject,
  type CreateProjectInput,
  type LocalPathSourceInput,
  type ProjectRecord,
  type WorkspaceProjectDeps,
} from "../src/workspace-project";

const anchor = { path: "/plugin/anchor" };

function project(id: string, name: string, sources: ProjectRecord["sources"] = []): ProjectRecord {
  return { id, name, sources };
}

function source(hostId: string, path: string): ProjectRecord["sources"][number] {
  return { id: `src_${hostId}_${path.replaceAll("/", "_")}`, hostId, path, isDefault: true };
}

function createDeps(initialProjects: ProjectRecord[], storedProjectId: string | null = null) {
  const projects = [...initialProjects];
  const calls: { create: CreateProjectInput[]; addSource: Array<{ projectId: string; input: LocalPathSourceInput }>; updateName: Array<{ projectId: string; name: string }> } = {
    create: [], addSource: [], updateName: [],
  };
  let stored = storedProjectId;
  const deps: WorkspaceProjectDeps = {
    getStoredProjectId: () => stored,
    setStoredProjectId: (id) => { stored = id; },
    ensureAnchor: async () => anchor,
    getProject: async (id) => projects.find((candidate) => candidate.id === id) ?? null,
    listProjects: async () => projects,
    createProject: async (input) => {
      calls.create.push(input);
      const created = project("proj_workspaces", input.name, [source(input.source.hostId, input.source.path)]);
      projects.push(created);
      return created;
    },
    addSource: async (projectId, input) => {
      calls.addSource.push({ projectId, input });
      const target = projects.find((candidate) => candidate.id === projectId);
      if (!target) throw new Error(`Project ${projectId} was not found`);
      target.sources.push(source(input.hostId, input.path));
    },
    updateProjectName: async (projectId: string, name: string) => {
      calls.updateName.push({ projectId, name });
      const target = projects.find((candidate) => candidate.id === projectId);
      if (!target) throw new Error(`Project ${projectId} was not found`);
      target.name = name;
    },
  } as WorkspaceProjectDeps & { updateProjectName(projectId: string, name: string): Promise<void> };
  return { deps, calls, getStored: () => stored, getProjects: () => projects };
}

describe("ensureWorkspaceProject", () => {
  it("creates and persists one neutral project for an anchor", async () => {
    const { deps, calls, getStored } = createDeps([]);

    expect(await ensureWorkspaceProject(deps, "host_local")).toBe("proj_workspaces");
    expect(calls.create).toEqual([{
      name: "🗂️ Workspace Hub",
      source: { type: "local_path", hostId: "host_local", path: "/plugin/anchor" },
    }]);
    expect(await ensureWorkspaceProject(deps, "host_local")).toBe("proj_workspaces");
    expect(calls.create).toHaveLength(1);
    expect(getStored()).toBe("proj_workspaces");
  });

  it("renames the stored legacy synthetic project without replacing it", async () => {
    const legacy = project("proj_workspaces", "🧩 Workspaces", [source("host_local", "/plugin/anchor")]);
    const { deps, calls, getProjects } = createDeps([legacy], "proj_workspaces");

    expect(await ensureWorkspaceProject(deps, "host_local")).toBe("proj_workspaces");
    expect(calls.create).toEqual([]);
    expect(calls.updateName).toEqual([{ projectId: "proj_workspaces", name: "🗂️ Workspace Hub" }]);
    expect(getProjects()[0]?.name).toBe("🗂️ Workspace Hub");
  });

  it("replaces a stored project that was deleted", async () => {
    const { deps, calls, getStored } = createDeps([], "proj_deleted");

    expect(await ensureWorkspaceProject(deps, "host_local")).toBe("proj_workspaces");
    expect(calls.create).toHaveLength(1);
    expect(getStored()).toBe("proj_workspaces");
  });

  it("attaches the anchor source when the stored project is absent from the host", async () => {
    const existing = project("proj_workspaces", "🗂️ Workspace Hub", [source("host_remote", "/plugin/anchor")]);
    const { deps, calls } = createDeps([existing], "proj_workspaces");

    expect(await ensureWorkspaceProject(deps, "host_local")).toBe("proj_workspaces");
    expect(calls.create).toEqual([]);
    expect(calls.addSource).toEqual([{
      projectId: "proj_workspaces",
      input: { type: "local_path", hostId: "host_local", path: "/plugin/anchor" },
    }]);
  });

  it("does not adopt a user project that only collides on display name", async () => {
    const userProject = project("proj_user", "🗂️ Workspace Hub", [source("host_local", "/repos/user-workspaces")]);
    const { deps, calls } = createDeps([userProject]);

    expect(await ensureWorkspaceProject(deps, "host_local")).toBe("proj_workspaces");
    expect(calls.create).toHaveLength(1);
    expect(calls.addSource).toEqual([]);
  });

  it("shares an in-flight ensure for the same host", async () => {
    const { deps, calls } = createDeps([]);

    await expect(Promise.all([
      ensureWorkspaceProject(deps, "host_local"),
      ensureWorkspaceProject(deps, "host_local"),
    ])).resolves.toEqual(["proj_workspaces", "proj_workspaces"]);
    expect(calls.create).toHaveLength(1);
    expect(calls.addSource).toHaveLength(0);
  });

  it("creates one project when different hosts ensure concurrently", async () => {
    const { deps, calls, getProjects } = createDeps([]);

    await expect(Promise.all([
      ensureWorkspaceProject(deps, "host_local"),
      ensureWorkspaceProject(deps, "host_remote"),
    ])).resolves.toEqual(["proj_workspaces", "proj_workspaces"]);

    expect(calls.create).toHaveLength(1);
    expect(calls.addSource).toHaveLength(1);
    expect(getProjects().find((candidate) => candidate.id === "proj_workspaces")?.sources
      .map((candidate) => candidate.hostId).sort()).toEqual(["host_local", "host_remote"]);
  });
});
