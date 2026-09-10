import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { WorkspaceStore, WORKSPACE_MIGRATIONS } from "../src/store";
import { SessionExpansionService, type SessionExpansionDeps } from "../src/session-expansion";

type Project = {
  id: string;
  name: string;
  sources: Array<{ id: string; hostId: string; path: string; isDefault: boolean }>;
};

function project(id: string, name: string, hostId = "host_1"): Project {
  return { id, name, sources: [{ id: `source_${id}`, hostId, path: `/repos/${id}`, isDefault: true }] };
}

function manifest(sessionId: string, repositories: Array<{ projectId: string; alias: string }>) {
  return {
    schemaVersion: 2 as const,
    owner: "bb-plugin-workspaces" as const,
    sessionId,
    workspaceName: "Platform",
    instructions: "",
    revision: 2,
    operations: [],
    repositories: repositories.map((repository) => ({
      ...repository,
      sourcePath: `/repos/${repository.projectId}`,
      baseRef: "HEAD",
      baseCommit: "abc123",
      branch: `bb-workspace/session-1/${repository.alias}`,
      worktreePath: `/sessions/${sessionId}/repos/${repository.alias}`,
    })),
  };
}

function createFixture(options: { policy?: "ask" | "auto"; projects?: Project[]; state?: "active" | "archived" | "cleaned" } = {}) {
  const db = new Database(":memory:");
  WORKSPACE_MIGRATIONS.forEach((migration) => db.exec(migration));
  const store = new WorkspaceStore(db);
  const workspace = store.create({
    name: "Platform",
    description: "",
    instructions: "",
    repositories: [
      { projectId: "proj_api", alias: "api" },
      { projectId: "proj_audits", alias: "audits" },
    ],
  });
  const session = store.createSessionSnapshot(workspace.id, workspace.revision, [{ projectId: "proj_api", alias: "api" }]);
  store.updateSession(session.id, { state: options.state ?? "active", hostId: "host_1", threadId: "thr_1" });
  if (options.policy) store.setExpansionPolicy(session.id, options.policy);
  const approvals: unknown[] = [];
  const hostAdds: unknown[] = [];
  const publications: unknown[] = [];
  const projects = options.projects ?? [project("proj_api", "API"), project("proj_audits", "Audits")];
  const deps: SessionExpansionDeps = {
    store,
    listProjects: async () => projects,
    requestApproval: async (payload) => {
      approvals.push(payload);
      return { action: "add-once" };
    },
    addRepository: async (input, hostId) => {
      hostAdds.push({ input, hostId });
      return {
        repository: {
          ...input.repository,
          baseCommit: "abc123",
          branch: `bb-workspace/session-1/${input.repository.alias}`,
          worktreePath: `/sessions/${input.sessionId}/repos/${input.repository.alias}`,
        },
        manifestRevision: 2,
      };
    },
    readSession: async (sessionId) => manifest(sessionId, [
      { projectId: "proj_api", alias: "api" },
      { projectId: "proj_audits", alias: "audits" },
    ]),
    publishChanged: async () => { publications.push({}); },
  };
  return { db, store, session, workspace, deps, approvals, hostAdds, publications, projects };
}

describe("SessionExpansionService", () => {
  it("asks then adds once through the trusted option", async () => {
    const fixture = createFixture();
    const service = new SessionExpansionService(fixture.deps);

    expect(await service.requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "The gateway imports the audit contract.", requestKey: "tool-call-1",
    })).toMatchObject({ added: true, alias: "audits", policy: "ask" });
    expect(fixture.approvals).toEqual([{
      sessionId: fixture.session.id,
      workspaceName: "Platform",
      repositoryAlias: "audits",
      repositoryName: "Audits",
      reason: "The gateway imports the audit contract.",
    }]);
    expect(fixture.hostAdds).toHaveLength(1);
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "provisioned", approvalMode: "once" }]);
  });

  it("persists auto policy before provisioning after add-and-auto approval", async () => {
    const fixture = createFixture();
    fixture.deps.requestApproval = async () => ({ action: "add-and-auto" });
    fixture.deps.addRepository = async () => {
      expect(fixture.store.getSession(fixture.session.id).expansionPolicy).toBe("auto");
      throw new Error("host unavailable");
    };
    const service = new SessionExpansionService(fixture.deps);

    expect(await service.requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "tool-call-2",
    })).toMatchObject({ added: false, error: "host unavailable" });
    expect(fixture.store.getSession(fixture.session.id)).toMatchObject({ expansionPolicy: "auto", expansions: [{ outcome: "failed", approvalMode: "auto" }] });
  });

  it("records a cancellation without calling the host", async () => {
    const fixture = createFixture();
    fixture.deps.requestApproval = async () => ({ action: "cancel" });
    const service = new SessionExpansionService(fixture.deps);

    expect(await service.requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "tool-call-3",
    })).toMatchObject({ added: false, cancelled: true });
    expect(fixture.hostAdds).toHaveLength(0);
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "cancelled" }]);
    expect(fixture.publications).toHaveLength(1);
  });

  it("auto policy skips approval only after current membership and host eligibility", async () => {
    const fixture = createFixture({ policy: "auto" });
    const service = new SessionExpansionService(fixture.deps);

    await service.requestFromAgent({ threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "tool-call-4" });
    expect(fixture.approvals).toHaveLength(0);
    expect(fixture.hostAdds).toHaveLength(1);

    const removed = createFixture({ policy: "auto", projects: [project("proj_api", "API")] });
    await expect(new SessionExpansionService(removed.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "tool-call-5",
    })).rejects.toThrow(/workspace|eligible|member/i);
    expect(removed.hostAdds).toHaveLength(0);
  });

  it.each([
    ["deleted workspace", (fixture: ReturnType<typeof createFixture>) => fixture.store.remove(fixture.workspace.id, fixture.workspace.revision)],
    ["inactive session", (fixture: ReturnType<typeof createFixture>) => fixture.store.updateSession(fixture.session.id, { state: "archived" })],
    ["already present", (fixture: ReturnType<typeof createFixture>) => fixture.store.reconcileRepositories(fixture.session.id, [{ projectId: "proj_api", alias: "api" }, { projectId: "proj_audits", alias: "audits" }], 2)],
  ])("rejects %s before host mutation", async (_case, alter) => {
    const fixture = createFixture();
    alter(fixture);

    await expect(new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "tool-call-6",
    })).rejects.toThrow();
    expect(fixture.hostAdds).toHaveLength(0);
  });

  it("rejects sources that exist only on a different host before host mutation", async () => {
    const fixture = createFixture({ projects: [project("proj_api", "API"), project("proj_audits", "Audits", "host_2")] });

    await expect(new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "tool-call-7",
    })).rejects.toThrow();
    expect(fixture.hostAdds).toHaveLength(0);
  });

  it("records manual additions as user/manual without changing policy", async () => {
    const fixture = createFixture({ policy: "ask" });
    const service = new SessionExpansionService(fixture.deps);

    expect(await service.addManually({ threadId: "thr_1", projectId: "proj_audits", requestKey: "manual-1" })).toMatchObject({ added: true, alias: "audits", policy: "ask" });
    expect(fixture.approvals).toHaveLength(0);
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ requester: "user", approvalMode: "manual", outcome: "provisioned" }]);
  });

  it("records host failure without changing recorded repositories", async () => {
    const fixture = createFixture();
    fixture.deps.addRepository = async () => { throw new Error("host failed"); };
    const service = new SessionExpansionService(fixture.deps);

    expect(await service.requestFromAgent({ threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "failure-1" })).toMatchObject({ added: false, error: "host failed" });
    expect(fixture.store.getSession(fixture.session.id)).toMatchObject({ repositories: [{ projectId: "proj_api", alias: "api" }], expansions: [{ outcome: "failed", error: "host failed" }] });
    expect(fixture.publications).toHaveLength(1);
  });

  it("repairs a database append failure from the host manifest", async () => {
    const fixture = createFixture();
    const originalAppend = fixture.store.appendProvisionedRepository.bind(fixture.store);
    let failOnce = true;
    fixture.store.appendProvisionedRepository = ((input) => {
      if (failOnce) { failOnce = false; throw new Error("database write failed"); }
      return originalAppend(input);
    }) as typeof fixture.store.appendProvisionedRepository;
    const service = new SessionExpansionService(fixture.deps);

    expect(await service.requestFromAgent({ threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "recovery-1" })).toMatchObject({ added: true, recovered: true });
    expect(fixture.store.getSession(fixture.session.id)).toMatchObject({
      repositories: [{ projectId: "proj_api", alias: "api" }, { projectId: "proj_audits", alias: "audits" }],
      expansions: [{ outcome: "provisioned" }],
    });
  });

  it("replays a completed request without another host call or publication", async () => {
    const fixture = createFixture({ policy: "auto" });
    const service = new SessionExpansionService(fixture.deps);
    const input = { threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "replay-1" };

    const first = await service.requestFromAgent(input);
    const replay = await service.requestFromAgent(input);
    expect(replay).toEqual(first);
    expect(fixture.hostAdds).toHaveLength(1);
    expect(fixture.publications).toHaveLength(1);
  });

  it("reconciles only active sessions in bulk", async () => {
    const active = createFixture();
    const archivedWorkspace = active.store.create({
      name: "Archived Platform",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_api", alias: "api" }, { projectId: "proj_audits", alias: "audits" }],
    });
    const archivedSession = active.store.createSessionSnapshot(
      archivedWorkspace.id, archivedWorkspace.revision, [{ projectId: "proj_api", alias: "api" }], "archived-request",
    );
    active.store.updateSession(archivedSession.id, { state: "archived", hostId: "host_1", threadId: "thr_archived" });
    const service = new SessionExpansionService(active.deps);

    await service.reconcileActiveSessions();
    expect(active.store.getSession(active.session.id).repositories).toHaveLength(2);
    expect(active.store.getSession(archivedSession.id).repositories).toHaveLength(1);
  });
});
