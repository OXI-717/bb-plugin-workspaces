import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { workspaceDraftSchema } from "./src/contracts";
import { hostContract } from "./src/host-contract";
import { WORKSPACE_MIGRATIONS, WorkspaceStore } from "./src/store";

const repositorySchema = z.object({ projectId: z.string(), alias: z.string(), ordinal: z.number().int() });
const workspaceSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), instructions: z.string(),
  revision: z.number().int(), pinned: z.boolean(), archivedAt: z.number().nullable(),
  createdAt: z.number(), updatedAt: z.number(), repositories: z.array(repositorySchema),
});
const sessionRepositorySchema = z.object({
  projectId: z.string(), alias: z.string(), sourceId: z.string().optional(), sourcePath: z.string().optional(),
  baseRef: z.string().optional(), baseCommit: z.string().optional(), branch: z.string().optional(), worktreePath: z.string().optional(),
});
const sessionExpansionSchema = z.object({
  id: z.string(), sessionId: z.string(), projectId: z.string(), alias: z.string(), reason: z.string(),
  requester: z.enum(["agent", "user", "reconcile"]), approvalMode: z.enum(["once", "auto", "manual", "reconciled"]),
  outcome: z.enum(["pending", "cancelled", "failed", "provisioned"]), requestKey: z.string(), error: z.string().nullable(),
  createdAt: z.number().int(), updatedAt: z.number().int(),
});
const sessionSchema = z.object({
  id: z.string(), workspaceId: z.string().nullable(), workspaceName: z.string(), workspaceRevision: z.number().int(),
  instructions: z.string(), repositories: z.array(sessionRepositorySchema), initialRepositories: z.array(sessionRepositorySchema),
  expansionPolicy: z.enum(["ask", "auto"]), expansions: z.array(sessionExpansionSchema), manifestRevision: z.number().int(),
  state: z.enum(["draft", "preparing", "active", "failed", "archived", "cleaned"]),
  hostId: z.string().nullable(), rootPath: z.string().nullable(), ownerProjectId: z.string().nullable(),
  threadId: z.string().nullable(), error: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(),
});
const projectSchema = z.object({
  id: z.string(), name: z.string(), gitRemoteUrl: z.string().nullable(),
  sources: z.array(z.object({ id: z.string(), hostId: z.string(), path: z.string(), isDefault: z.boolean() })),
});

export const rpcContract = defineRpcContract({
  dashboard: { input: z.null(), output: z.object({ workspaces: z.array(workspaceSchema), sessions: z.array(sessionSchema), projects: z.array(projectSchema) }) },
  workspace_create: { input: workspaceDraftSchema, output: workspaceSchema },
  workspace_update: { input: z.object({ id: z.string(), expectedRevision: z.number().int(), draft: workspaceDraftSchema }), output: workspaceSchema },
  workspace_set_pinned: { input: z.object({ id: z.string(), expectedRevision: z.number().int(), pinned: z.boolean() }), output: workspaceSchema },
  workspace_set_archived: { input: z.object({ id: z.string(), expectedRevision: z.number().int(), archived: z.boolean() }), output: workspaceSchema },
  workspace_remove: { input: z.object({ id: z.string(), expectedRevision: z.number().int() }), output: z.object({ removed: z.literal(true) }) },
  session_start: {
    input: z.object({
      workspaceId: z.string(), expectedRevision: z.number().int(), hostId: z.string(),
      projectIds: z.array(z.string()).min(1).max(20), prompt: z.string().trim().min(1).max(100_000),
      requestKey: z.string().min(8).max(200),
    }),
    output: sessionSchema,
  },
  session_archive: { input: z.object({ id: z.string() }), output: sessionSchema },
  session_cleanup: { input: z.object({ id: z.string() }), output: sessionSchema },
  session_repository_status: {
    input: z.object({ sessionId: z.string(), projectId: z.string() }),
    output: z.object({
      clean: z.boolean(), head: z.string(), aheadOfBase: z.boolean(),
      changedFiles: z.array(z.object({ path: z.string(), status: z.enum(["added", "modified", "deleted", "renamed", "untracked", "conflicted"]) })),
    }),
  },
});

const WORKSPACES_CHANGED = "workspaces-changed";

export default async function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, WORKSPACE_MIGRATIONS);
  const store = new WorkspaceStore(database);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const changed = () => bb.realtime.publish(WORKSPACES_CHANGED, { at: Date.now() });

  async function projects() {
    const rows = await bb.sdk.projects.list();
    return rows.map((project) => ({
      id: project.id, name: project.name, gitRemoteUrl: project.gitRemoteUrl,
      sources: project.sources.map((source) => ({ id: source.id, hostId: source.hostId, path: source.path, isDefault: source.isDefault })),
    }));
  }

  bb.rpc.register(rpcContract, {
    dashboard: async () => ({ workspaces: store.list(true), sessions: store.listSessions(), projects: await projects() }),
    workspace_create: async (draft) => {
      const projectIds = new Set((await projects()).map((project) => project.id));
      for (const repository of draft.repositories) if (!projectIds.has(repository.projectId)) throw new Error(`BB project ${repository.projectId} was not found`);
      const workspace = store.create(draft); changed(); return workspace;
    },
    workspace_update: async ({ id, expectedRevision, draft }) => { const workspace = store.update(id, expectedRevision, draft); changed(); return workspace; },
    workspace_set_pinned: async ({ id, expectedRevision, pinned }) => { const workspace = store.setPinned(id, expectedRevision, pinned); changed(); return workspace; },
    workspace_set_archived: async ({ id, expectedRevision, archived }) => { const workspace = store.setArchived(id, expectedRevision, archived); changed(); return workspace; },
    workspace_remove: async ({ id, expectedRevision }) => { store.remove(id, expectedRevision); changed(); return { removed: true as const }; },
    session_start: async ({ workspaceId, expectedRevision, hostId, projectIds, prompt, requestKey }) => {
      const existing = store.getSessionByRequestKey(requestKey);
      if (existing) return existing;
      const workspace = store.get(workspaceId);
      if (workspace.revision !== expectedRevision) throw new Error("Workspace revision is stale");
      const selectedSet = new Set(projectIds);
      if (selectedSet.size !== projectIds.length) throw new Error("Select each repository only once");
      const selected = workspace.repositories.filter((repository) => selectedSet.has(repository.projectId));
      if (selected.length !== selectedSet.size) throw new Error("One or more selected projects are not in this workspace");
      const primaryProjectId = selected[0]!.projectId;
      const available = new Map((await projects()).map((project) => [project.id, project]));
      const resolved = selected.map((repository) => {
        const project = available.get(repository.projectId);
        if (!project) throw new Error(`BB project ${repository.projectId} was not found`);
        const source = project.sources.find((candidate) => candidate.hostId === hostId && candidate.isDefault)
          ?? project.sources.find((candidate) => candidate.hostId === hostId);
        if (!source) throw new Error(`${project.name} has no source on the selected host`);
        return { ...repository, sourceId: source.id, sourcePath: source.path, baseRef: "HEAD" };
      });
      let session = store.createSessionSnapshot(workspaceId, expectedRevision, selected, requestKey);
      session = store.updateSession(session.id, { state: "preparing", hostId, primaryProjectId, error: null });
      changed();
      try {
        const prepared = await host.call("prepare_session", {
          sessionId: session.id, workspaceName: workspace.name, instructions: workspace.instructions,
          repositories: resolved.map(({ projectId, alias, sourcePath, baseRef }) => ({ projectId, alias, sourcePath, baseRef })),
        }, { hostId });
        session = store.setSessionRepositories(session.id, prepared.repositories.map((repository) => ({
          projectId: repository.projectId, alias: repository.alias,
          sourceId: resolved.find((candidate) => candidate.projectId === repository.projectId)?.sourceId,
          sourcePath: repository.sourcePath, baseRef: repository.baseRef, baseCommit: repository.baseCommit,
          branch: repository.branch, worktreePath: repository.worktreePath,
        })));
        session = store.updateSession(session.id, { rootPath: prepared.rootPath });
        const thread = await bb.sdk.threads.spawn({
          projectId: primaryProjectId,
          environment: { type: "host", hostId, workspace: { type: "unmanaged", path: prepared.rootPath } },
          prompt, title: `🧩 ${workspace.name} · ${prompt.slice(0, 72)}`, visibility: "visible",
        });
        session = store.updateSession(session.id, { state: "active", threadId: thread.id }); changed(); return session;
      } catch (error) {
        store.updateSession(session.id, { state: "failed", error: error instanceof Error ? error.message : String(error) });
        changed(); throw error;
      }
    },
    session_archive: async ({ id }) => {
      const current = store.getSession(id);
      if (current.state === "cleaned") throw new Error("A cleaned session cannot be archived again");
      const session = store.updateSession(id, { state: "archived" }); changed(); return session;
    },
    session_cleanup: async ({ id }) => {
      const session = store.getSession(id);
      if (session.state !== "archived") throw new Error("Archive the session before cleaning up its worktrees");
      if (!session.hostId) throw new Error("Session host is unavailable");
      const repositories = session.repositories.map((repository) => {
        if (!repository.sourcePath || !repository.baseRef || !repository.baseCommit || !repository.branch || !repository.worktreePath) {
          throw new Error(`Repository ${repository.alias} was not fully prepared`);
        }
        return {
          projectId: repository.projectId, alias: repository.alias, sourcePath: repository.sourcePath,
          baseRef: repository.baseRef, baseCommit: repository.baseCommit, branch: repository.branch,
          worktreePath: repository.worktreePath,
        };
      });
      await host.call("cleanup_session", { sessionId: session.id, repositories }, { hostId: session.hostId });
      const cleaned = store.updateSession(id, { state: "cleaned", rootPath: null, error: null });
      changed(); return cleaned;
    },
    session_repository_status: async ({ sessionId, projectId }) => {
      const session = store.getSession(sessionId);
      const repository = session.repositories.find((candidate) => candidate.projectId === projectId);
      if (!repository?.worktreePath || !repository.baseCommit || !session.hostId) throw new Error("Repository checkout is not ready");
      return host.call("repository_status", { worktreePath: repository.worktreePath, baseCommit: repository.baseCommit }, { hostId: session.hostId });
    },
  });

  const usage = ["Usage:", "  bb workspaces list [--json]", "  bb workspaces show <workspace-id> [--json]", "  bb workspaces sessions [--json]"].join("\n");
  bb.cli.register({
    name: "workspaces", summary: "List multi-repository workspaces and sessions",
    commands: [
      { name: "list", summary: "List workspaces", usage: "bb workspaces list [--json]" },
      { name: "show", summary: "Show one workspace", usage: "bb workspaces show <workspace-id> [--json]" },
      { name: "sessions", summary: "List workspace sessions", usage: "bb workspaces sessions [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json"); const args = argv.filter((arg) => arg !== "--json");
      const output = (value: unknown, human: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value, null, 2) : human });
      if (args[0] === "list") { const rows = store.list(true); return output(rows, rows.length ? rows.map((workspace) => `${workspace.id}  ${workspace.name}  (${workspace.repositories.length} repos)`).join("\n") : "No workspaces."); }
      if (args[0] === "show" && args.length === 2) { const workspace = store.get(args[1]!); return output(workspace, `${workspace.name}\n${workspace.repositories.map((repository) => `  ${repository.alias}: ${repository.projectId}`).join("\n")}`); }
      if (args[0] === "sessions") { const rows = store.listSessions(); return output(rows, rows.length ? rows.map((session) => `${session.id}  ${session.state}  ${session.workspaceName}`).join("\n") : "No sessions."); }
      return { exitCode: args[0] === undefined || args[0] === "help" || args[0] === "--help" ? 0 : 1, stdout: usage };
    },
  });
  bb.log.info("loaded");
}
