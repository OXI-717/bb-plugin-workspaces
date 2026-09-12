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

function addWorkersRepository(fixture: ReturnType<typeof createFixture>) {
  fixture.projects.push(project("proj_workers", "Workers"));
  const workspace = fixture.store.get(fixture.workspace.id);
  fixture.store.update(workspace.id, workspace.revision, {
    name: workspace.name,
    description: workspace.description,
    instructions: workspace.instructions,
    repositories: [
      ...workspace.repositories.map(({ projectId, alias }) => ({ projectId, alias })),
      { projectId: "proj_workers", alias: "workers" },
    ],
  });
}

function addSecondActiveSession(fixture: ReturnType<typeof createFixture>) {
  const workspace = fixture.store.get(fixture.workspace.id);
  const session = fixture.store.createSessionSnapshot(
    workspace.id, workspace.revision, [{ projectId: "proj_api", alias: "api" }], "second-session-1",
  );
  return fixture.store.updateSession(session.id, { state: "active", hostId: "host_1", threadId: "thr_2" });
}

describe("SessionExpansionService", () => {
  it("offers unenrolled host projects alongside workspace members", async () => {
    const fixture = createFixture({ projects: [project("proj_api", "API"), project("proj_audits", "Audits"), project("proj_workers", "Workers"), project("proj_remote", "Remote", "host_2")] });
    expect(await new SessionExpansionService(fixture.deps).candidatesForThread("thr_1")).toEqual([
      { projectId: "proj_audits", alias: "audits", projectName: "Audits", sourcePath: "/repos/proj_audits", member: true },
      { projectId: "proj_workers", alias: "workers", projectName: "Workers", sourcePath: "/repos/proj_workers", member: false },
    ]);
  });

  it("suffixes a candidate alias that collides with existing membership", async () => {
    const fixture = createFixture({ projects: [project("proj_api", "API"), project("proj_audits", "Audits"), project("proj_audits_fork", "Audits")] });
    expect(await new SessionExpansionService(fixture.deps).candidatesForThread("thr_1"))
      .toMatchObject([{ alias: "audits", member: true }, { projectId: "proj_audits_fork", alias: "audits-2", member: false }]);
  });

  it("enrolls an unenrolled project into the workspace before provisioning it", async () => {
    const fixture = createFixture({ projects: [project("proj_api", "API"), project("proj_audits", "Audits"), project("proj_workers", "Workers")] });
    fixture.deps.readSession = async (sessionId) => manifest(sessionId, [{ projectId: "proj_api", alias: "api" }, { projectId: "proj_workers", alias: "workers" }]);
    const result = await new SessionExpansionService(fixture.deps).addManually({ threadId: "thr_1", projectId: "proj_workers", requestKey: "enrolling-add" });
    expect(result).toMatchObject({ added: true, outcome: "provisioned", alias: "workers" });
    expect(fixture.store.get(fixture.workspace.id).repositories).toContainEqual({ projectId: "proj_workers", alias: "workers", ordinal: 2 });
    expect(fixture.approvals).toHaveLength(0);
  });

  it("keeps the agent confined to repositories already saved in the workspace", async () => {
    const fixture = createFixture({ projects: [project("proj_api", "API"), project("proj_audits", "Audits"), project("proj_workers", "Workers")] });
    const service = new SessionExpansionService(fixture.deps);
    await expect(service.requestFromAgent({ threadId: "thr_1", alias: "workers", reason: "Required", requestKey: "agent-newcomer" }))
      .rejects.toThrow(/not eligible/);
    expect(fixture.store.get(fixture.workspace.id).repositories).toHaveLength(2);
    expect(fixture.hostAdds).toHaveLength(0);
  });

  it.each(["approved", "provisioning", "uncertain"])("resumes orphaned %s work during a normal read", async (phase) => {
    const fixture = createFixture();
    fixture.store.beginExpansion({ sessionId: fixture.session.id, projectId: "proj_audits", alias: "audits", reason: "Required", requester: "agent", approvalMode: "once", requestKey: "orphaned-operation" });
    fixture.db.prepare("UPDATE session_expansions SET phase = ? WHERE request_key = ?").run(phase, "orphaned-operation");
    fixture.deps.readSession = async (sessionId) => manifest(sessionId, [{ projectId: "proj_api", alias: "api" }]);
    expect((await new SessionExpansionService(fixture.deps).reconcileSession(fixture.session.id)).expansions).toMatchObject([{ outcome: "provisioned" }]);
    expect(fixture.approvals).toHaveLength(0);
    expect(fixture.hostAdds).toHaveLength(1);
  });

  it.each(["awaiting-approval", null])("cancels abandoned approval phase %s on normal read without approving it", async (phase) => {
    const fixture = createFixture({ policy: "auto" });
    fixture.store.beginExpansion({ sessionId: fixture.session.id, projectId: "proj_audits", alias: "audits", reason: "Required", requester: "agent", approvalMode: "once", requestKey: "orphaned-approval" });
    fixture.db.prepare("UPDATE session_expansions SET phase = ? WHERE request_key = ?").run(phase, "orphaned-approval");
    fixture.deps.readSession = async (sessionId) => manifest(sessionId, [{ projectId: "proj_api", alias: "api" }]);
    expect((await new SessionExpansionService(fixture.deps).reconcileSession(fixture.session.id)).expansions).toMatchObject([{ outcome: "cancelled" }]);
    expect(fixture.approvals).toHaveLength(0); expect(fixture.hostAdds).toHaveLength(0);
  });

  it("does not cancel an in-flight approval during dashboard reconciliation", async () => {
    const fixture = createFixture();
    let decide!: (value: unknown) => void;
    let seen!: () => void;
    const ready = new Promise<void>((resolve) => { seen = resolve; });
    fixture.deps.requestApproval = async () => new Promise((resolve) => { decide = resolve; seen(); });
    fixture.deps.readSession = async (sessionId) => manifest(sessionId, [{ projectId: "proj_api", alias: "api" }]);
    const service = new SessionExpansionService(fixture.deps);
    const request = service.requestFromAgent({ threadId: "thr_1", alias: "audits", reason: "Required", requestKey: "live-approval" });
    await ready;
    expect((await service.reconcileSession(fixture.session.id)).expansions).toMatchObject([{ outcome: "pending", phase: "awaiting-approval" }]);
    decide({ action: "add-once" }); expect(await request).toMatchObject({ outcome: "provisioned" });
  });
  it("rejects an accumulated repository overflow before provisioning", async () => {
    const fixture = createFixture();
    const repositories = [...fixture.session.repositories, ...Array.from({ length: 1023 }, (_, index) => ({ projectId: `extra-${index}`, alias: `extra-${index}` }))];
    fixture.db.prepare("UPDATE sessions SET repositories_json = ? WHERE id = ?").run(JSON.stringify(repositories), fixture.session.id);
    await expect(new SessionExpansionService(fixture.deps).addManually({ threadId: "thr_1", projectId: "proj_audits", requestKey: "overflow-add" })).rejects.toThrow(/1024|limit/i);
    expect(fixture.hostAdds).toHaveLength(0);
  });
  it("returns explicit failed outcome and bounded nullable error", async () => {
    const fixture = createFixture();
    fixture.deps.addRepository = async () => { throw new Error("x".repeat(1000)); };
    const result = await new SessionExpansionService(fixture.deps).addManually({ threadId: "thr_1", projectId: "proj_audits", requestKey: "bounded-failure" });
    expect(result).toMatchObject({ outcome: "failed", error: "x".repeat(500) });
    expect(result.session.expansions[0]?.error).toHaveLength(500);
  });

  it("settles concurrent different keys for the same repository successfully", async () => {
    const fixture = createFixture({ policy: "auto" });
    const service = new SessionExpansionService(fixture.deps);
    const results = await Promise.all(["concurrent-one", "concurrent-two"].map((requestKey) => service.addManually({ threadId: "thr_1", projectId: "proj_audits", requestKey })));
    expect(results.every((result) => result.added)).toBe(true);
    expect(fixture.store.getSession(fixture.session.id).expansions.map((row) => row.outcome).sort()).toEqual(["provisioned", "superseded"]);
  });

  it("settles matching manifest operations during ordinary reconciliation", async () => {
    const fixture = createFixture();
    fixture.store.beginExpansion({ sessionId: fixture.session.id, projectId: "proj_audits", alias: "audits", reason: "Required", requester: "user", approvalMode: "manual", requestKey: "read-recovery" });
    fixture.deps.readSession = async (sessionId) => ({ ...manifest(sessionId, [{ projectId: "proj_api", alias: "api" }, { projectId: "proj_audits", alias: "audits" }]), operations: [{ key: "read-recovery", projectId: "proj_audits", alias: "audits" }] });
    expect((await new SessionExpansionService(fixture.deps).reconcileSession(fixture.session.id)).expansions).toMatchObject([{ outcome: "provisioned" }]);
  });

  it.each(["approved", "provisioning", "uncertain", null])("recovers a crash before host mutation from phase %s", async (phase) => {
    const fixture = createFixture();
    fixture.store.beginExpansion({ sessionId: fixture.session.id, projectId: "proj_audits", alias: "audits", reason: "Required", requester: "user", approvalMode: "manual", requestKey: "crash-recovery" });
    const columns = fixture.db.pragma("table_info(session_expansions)") as Array<{ name: string }>;
    if (columns.some((column) => column.name === "phase")) fixture.db.prepare("UPDATE session_expansions SET phase = ? WHERE request_key = ?").run(phase, "crash-recovery");
    fixture.deps.readSession = async (sessionId) => manifest(sessionId, [{ projectId: "proj_api", alias: "api" }]);
    expect(await new SessionExpansionService(fixture.deps).addManually({ threadId: "thr_1", projectId: "proj_audits", requestKey: "crash-recovery" })).toMatchObject({ added: true, outcome: "provisioned", error: null });
    expect(fixture.hostAdds).toHaveLength(1);
  });

  it("asks again for a phase-less agent crash even if session policy is now auto", async () => {
    const fixture = createFixture({ policy: "auto" });
    fixture.store.beginExpansion({ sessionId: fixture.session.id, projectId: "proj_audits", alias: "audits", reason: "Required", requester: "agent", approvalMode: "once", requestKey: "approval-crash" });
    fixture.deps.readSession = async (sessionId) => manifest(sessionId, [{ projectId: "proj_api", alias: "api" }]);
    fixture.deps.requestApproval = async (payload) => { fixture.approvals.push(payload); return { action: "cancel" }; };
    expect(await new SessionExpansionService(fixture.deps).requestFromAgent({ threadId: "thr_1", alias: "audits", reason: "Required", requestKey: "approval-crash" })).toMatchObject({ outcome: "cancelled", error: null });
    expect(fixture.approvals).toHaveLength(1);
    expect(fixture.hostAdds).toHaveLength(0);
  });
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
    fixture.deps.readSession = async (sessionId) => ({
      ...manifest(sessionId, [{ projectId: "proj_api", alias: "api" }, { projectId: "proj_audits", alias: "audits" }]),
      operations: [{ key: "recovery-1", projectId: "proj_audits", alias: "audits" }],
    });
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

  it("rechecks eligibility after approval before calling the host", async () => {
    const fixture = createFixture();
    let decide!: (value: unknown) => void;
    let approvalSeen!: () => void;
    const seen = new Promise<void>((resolve) => { approvalSeen = resolve; });
    fixture.deps.requestApproval = async (payload) => {
      fixture.approvals.push(payload);
      return new Promise((resolve) => { decide = resolve; approvalSeen(); });
    };
    const request = new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "stale-approval-1",
    });
    await seen;
    fixture.store.remove(fixture.workspace.id, fixture.workspace.revision);
    decide({ action: "add-once" });

    expect(await request).toMatchObject({ added: false, error: expect.stringMatching(/workspace/i) });
    expect(fixture.hostAdds).toHaveLength(0);
  });

  it("claims simultaneous request keys once for approval, host provisioning, and publication", async () => {
    const fixture = createFixture();
    let decide!: (value: unknown) => void;
    let approvalSeen!: () => void;
    const seen = new Promise<void>((resolve) => { approvalSeen = resolve; });
    fixture.deps.requestApproval = async (payload) => {
      fixture.approvals.push(payload);
      return new Promise((resolve) => { decide = resolve; approvalSeen(); });
    };
    const service = new SessionExpansionService(fixture.deps);
    const input = { threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "same-request-1" };
    const first = service.requestFromAgent(input);
    const second = service.requestFromAgent(input);
    await seen;
    expect(fixture.approvals).toHaveLength(1);
    decide({ action: "add-once" });

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { added: true, alias: "audits", policy: "ask", session: { id: fixture.session.id } },
      { added: true, alias: "audits", policy: "ask", session: { id: fixture.session.id } },
    ]);
    expect(fixture.hostAdds).toHaveLength(1);
    expect(fixture.publications).toHaveLength(1);
  });

  it("rejects sequential manual request-key reuse across sessions or repositories", async () => {
    const fixture = createFixture({ policy: "auto" });
    addWorkersRepository(fixture);
    addSecondActiveSession(fixture);
    const service = new SessionExpansionService(fixture.deps);

    await service.addManually({ threadId: "thr_1", projectId: "proj_audits", requestKey: "manual-collision-1" });
    await expect(service.addManually({ threadId: "thr_2", projectId: "proj_audits", requestKey: "manual-collision-1" }))
      .rejects.toThrow(/different session/i);
    await expect(service.addManually({ threadId: "thr_1", projectId: "proj_workers", requestKey: "manual-collision-1" }))
      .rejects.toThrow(/different project/i);
    expect(fixture.hostAdds).toHaveLength(1);
  });

  it("does not combine concurrent manual request-key collisions", async () => {
    const fixture = createFixture({ policy: "auto" });
    addWorkersRepository(fixture);
    addSecondActiveSession(fixture);
    const service = new SessionExpansionService(fixture.deps);

    const results = await Promise.allSettled([
      service.addManually({ threadId: "thr_1", projectId: "proj_audits", requestKey: "manual-race-key-1" }),
      service.addManually({ threadId: "thr_2", projectId: "proj_audits", requestKey: "manual-race-key-1" }),
      service.addManually({ threadId: "thr_1", projectId: "proj_workers", requestKey: "manual-race-key-1" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => String((result as PromiseRejectedResult).reason)))
      .toEqual(expect.arrayContaining([expect.stringMatching(/different session/i), expect.stringMatching(/different project/i)]));
    expect(fixture.hostAdds).toHaveLength(1);
  });

  it("rejects sequential agent request-key reuse across sessions or aliases", async () => {
    const fixture = createFixture({ policy: "auto" });
    addWorkersRepository(fixture);
    addSecondActiveSession(fixture);
    const service = new SessionExpansionService(fixture.deps);

    await service.requestFromAgent({ threadId: "thr_1", alias: "audits", reason: "Need audit contracts.", requestKey: "agent-collision-1" });
    await expect(service.requestFromAgent({ threadId: "thr_2", alias: "audits", reason: "Need audit contracts.", requestKey: "agent-collision-1" }))
      .rejects.toThrow(/different session/i);
    await expect(service.requestFromAgent({ threadId: "thr_1", alias: "workers", reason: "Need worker contracts.", requestKey: "agent-collision-1" }))
      .rejects.toThrow(/different alias/i);
    expect(fixture.hostAdds).toHaveLength(1);
  });

  it("does not combine concurrent agent request-key collisions", async () => {
    const fixture = createFixture({ policy: "auto" });
    addWorkersRepository(fixture);
    addSecondActiveSession(fixture);
    const service = new SessionExpansionService(fixture.deps);

    const results = await Promise.allSettled([
      service.requestFromAgent({ threadId: "thr_1", alias: "audits", reason: "Need audit contracts.", requestKey: "agent-race-key-1" }),
      service.requestFromAgent({ threadId: "thr_2", alias: "audits", reason: "Need audit contracts.", requestKey: "agent-race-key-1" }),
      service.requestFromAgent({ threadId: "thr_1", alias: "workers", reason: "Need worker contracts.", requestKey: "agent-race-key-1" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => String((result as PromiseRejectedResult).reason)))
      .toEqual(expect.arrayContaining([expect.stringMatching(/different session/i), expect.stringMatching(/different alias/i)]));
    expect(fixture.hostAdds).toHaveLength(1);
  });

  it("keeps disk-present expansion pending until a replay repairs its matching manifest operation", async () => {
    const fixture = createFixture();
    fixture.store.appendProvisionedRepository = (() => { throw new Error("database unavailable"); }) as typeof fixture.store.appendProvisionedRepository;
    let available = false;
    fixture.deps.readSession = async (sessionId) => {
      if (!available) throw new Error("manifest unavailable");
      return { ...manifest(sessionId, [{ projectId: "proj_api", alias: "api" }, { projectId: "proj_audits", alias: "audits" }]), operations: [{ key: "pending-disk-1", projectId: "proj_audits", alias: "audits" }] };
    };
    const service = new SessionExpansionService(fixture.deps);
    const input = { threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "pending-disk-1" };

    expect(await service.requestFromAgent(input)).toMatchObject({ added: false, pending: true, error: expect.stringMatching(/exists on disk/i) });
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "pending" }]);
    available = true;
    expect(await service.requestFromAgent(input)).toMatchObject({ added: true, recovered: true });
    expect(fixture.hostAdds).toHaveLength(1);
    expect(fixture.publications).toHaveLength(1);
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "provisioned" }]);
  });

  it("does not let notification failure alter a provisioned outcome or trigger recovery", async () => {
    const fixture = createFixture();
    let attempts = 0;
    fixture.deps.publishChanged = async () => { attempts += 1; throw new Error("realtime unavailable"); };

    expect(await new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "publish-failure-1",
    })).toMatchObject({ added: true });
    expect(attempts).toBe(1);
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "provisioned" }]);
  });

  it("rejects an alias already used by a different session project before host mutation", async () => {
    const fixture = createFixture();
    fixture.store.reconcileRepositories(fixture.session.id, [
      { projectId: "proj_api", alias: "api" },
      { projectId: "proj_existing", alias: "audits" },
    ], 2);

    await expect(new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "alias-collision-1",
    })).rejects.toThrow(/eligible/i);
    expect(fixture.hostAdds).toHaveLength(0);
  });

  it("returns per-session bulk reconciliation failures while retaining successful repairs", async () => {
    const fixture = createFixture();
    const second = fixture.store.createSessionSnapshot(fixture.workspace.id, fixture.workspace.revision, [{ projectId: "proj_api", alias: "api" }], "bulk-second-1");
    fixture.store.updateSession(second.id, { state: "active", hostId: "host_1", threadId: "thr_second" });
    fixture.deps.readSession = async (sessionId) => {
      if (sessionId === second.id) throw new Error("second host unavailable");
      return manifest(sessionId, [{ projectId: "proj_api", alias: "api" }, { projectId: "proj_audits", alias: "audits" }]);
    };

    const results = await new SessionExpansionService(fixture.deps).reconcileActiveSessions();
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: fixture.session.id, session: expect.objectContaining({ id: fixture.session.id }) }),
      expect.objectContaining({ sessionId: second.id, error: "second host unavailable" }),
    ]));
    expect(fixture.store.getSession(fixture.session.id).repositories).toHaveLength(2);
    expect(fixture.store.getSession(second.id).repositories).toHaveLength(1);
  });

  it("records an aborted approval as cancelled without calling the host", async () => {
    const fixture = createFixture();
    fixture.deps.requestApproval = async () => {
      const error = new Error("approval aborted");
      error.name = "AbortError";
      throw error;
    };

    expect(await new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "approval-abort-1",
    })).toMatchObject({ added: false, cancelled: true });
    expect(fixture.hostAdds).toHaveLength(0);
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "cancelled" }]);
  });

  it("keeps the claimed session when its thread is remapped during approval", async () => {
    const fixture = createFixture();
    let decide!: (value: unknown) => void;
    let approvalSeen!: () => void;
    const seen = new Promise<void>((resolve) => { approvalSeen = resolve; });
    fixture.deps.requestApproval = async () => new Promise((resolve) => { decide = resolve; approvalSeen(); });
    const request = new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "thread-remap-1",
    });
    await seen;
    fixture.store.updateSession(fixture.session.id, { threadId: "thr_old" });
    const replacement = fixture.store.createSessionSnapshot(fixture.workspace.id, fixture.workspace.revision, [{ projectId: "proj_api", alias: "api" }], "thread-remap-replacement");
    fixture.store.updateSession(replacement.id, { state: "active", hostId: "host_1", threadId: "thr_1" });
    decide({ action: "add-once" });

    expect(await request).toMatchObject({ added: true });
    expect(fixture.hostAdds).toMatchObject([{ input: { sessionId: fixture.session.id } }]);
  });

  it("rereads session state after deferred project discovery before host mutation", async () => {
    const fixture = createFixture();
    let projectCalls = 0;
    let releaseProjects!: (projects: Project[]) => void;
    let finalLookupSeen!: () => void;
    const finalLookup = new Promise<void>((resolve) => { finalLookupSeen = resolve; });
    fixture.deps.listProjects = async () => {
      projectCalls += 1;
      if (projectCalls === 1) return fixture.projects;
      finalLookupSeen();
      return new Promise((resolve) => { releaseProjects = resolve; });
    };
    const request = new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "deferred-projects-1",
    });
    await finalLookup;
    fixture.store.updateSession(fixture.session.id, { state: "archived" });
    releaseProjects(fixture.projects);

    expect(await request).toMatchObject({ added: false, error: expect.stringMatching(/active/i) });
    expect(fixture.hostAdds).toHaveLength(0);
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "failed" }]);
  });

  it("reports a realtime publication failure once without changing the provisioned result", async () => {
    const fixture = createFixture();
    const reports: unknown[] = [];
    let publishAttempts = 0;
    fixture.deps.publishChanged = async () => { publishAttempts += 1; throw new Error("realtime unavailable"); };
    fixture.deps.reportError = (report) => { reports.push(report); };

    expect(await new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "report-publish-1",
    })).toMatchObject({ added: true });
    expect(reports).toEqual([{
      operation: "workspaces-changed",
      sessionId: fixture.session.id,
      error: "realtime unavailable",
    }]);
    expect(publishAttempts).toBe(1);
  });

  it("records an AbortError during revalidation as failed rather than cancelled", async () => {
    const fixture = createFixture();
    let projectCalls = 0;
    fixture.deps.listProjects = async () => {
      projectCalls += 1;
      if (projectCalls === 1) return fixture.projects;
      const error = new Error("project lookup aborted");
      error.name = "AbortError";
      throw error;
    };

    expect(await new SessionExpansionService(fixture.deps).requestFromAgent({
      threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "revalidation-abort-1",
    })).toMatchObject({ added: false, error: "project lookup aborted" });
    expect(fixture.hostAdds).toHaveLength(0);
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "failed" }]);
  });

  it("keeps a host AbortError pending and recovers it from its matching manifest operation", async () => {
    const fixture = createFixture();
    fixture.deps.addRepository = async () => {
      const error = new Error("host request aborted");
      error.name = "AbortError";
      throw error;
    };
    const service = new SessionExpansionService(fixture.deps);
    const input = { threadId: "thr_1", alias: "audits", reason: "Need audits.", requestKey: "host-abort-1" };

    expect(await service.requestFromAgent(input)).toMatchObject({ added: false, pending: true, error: "host request aborted" });
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "pending" }]);
    fixture.deps.readSession = async (sessionId) => ({
      ...manifest(sessionId, [{ projectId: "proj_api", alias: "api" }, { projectId: "proj_audits", alias: "audits" }]),
      operations: [{ key: "host-abort-1", projectId: "proj_audits", alias: "audits" }],
    });

    expect(await service.requestFromAgent(input)).toMatchObject({ added: true, recovered: true });
    expect(fixture.store.getSession(fixture.session.id).expansions).toMatchObject([{ outcome: "provisioned" }]);
  });
});
