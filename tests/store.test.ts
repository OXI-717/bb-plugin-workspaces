import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { WORKSPACE_MIGRATIONS, WorkspaceStore } from "../src/store";

const createStore = (): { db: Database.Database; store: WorkspaceStore } => {
  const db = new Database(":memory:");
  WORKSPACE_MIGRATIONS.forEach((migration) => db.exec(migration));
  return { db, store: new WorkspaceStore(db) };
};

describe("WorkspaceStore", () => {
  it("keeps one repository in multiple workspaces and snapshots sessions", () => {
    const { store } = createStore();
    const first = store.create({
      name: "Authentication",
      description: "",
      instructions: "Run contract tests.",
      repositories: [{ projectId: "proj_auth", alias: "auth" }],
    });
    const second = store.create({
      name: "Platform",
      description: "Shared services",
      instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "identity" }],
    });

    expect(store.get(second.id).repositories).toEqual([
      { projectId: "proj_auth", alias: "identity", ordinal: 0 },
    ]);

    const session = store.createSessionSnapshot(first.id, first.revision, [
      { projectId: "proj_auth", alias: "auth" },
    ]);
    store.update(first.id, first.revision, {
      ...first,
      name: "Identity",
      repositories: [{ projectId: "proj_other", alias: "other" }],
    });

    expect(store.getSession(session.id)).toMatchObject({
      workspaceName: "Authentication",
      instructions: "Run contract tests.",
      repositories: [{ projectId: "proj_auth", alias: "auth" }],
    });
  });

  it("rejects stale revisions, invalid aliases, and duplicate aliases", () => {
    const { store } = createStore();
    const workspace = store.create({
      name: "Platform",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_a", alias: "api" }],
    });

    expect(() =>
      store.update(workspace.id, workspace.revision - 1, {
        ...workspace,
        name: "Changed",
      }),
    ).toThrow(/revision/i);
    expect(() =>
      store.create({
        name: "Bad",
        description: "",
        instructions: "",
        repositories: [{ projectId: "proj_a", alias: "../escape" }],
      }),
    ).toThrow(/alias/i);
    expect(() =>
      store.create({
        name: "Duplicates",
        description: "",
        instructions: "",
        repositories: [
          { projectId: "proj_a", alias: "api" },
          { projectId: "proj_b", alias: "api" },
        ],
      }),
    ).toThrow(/alias/i);
  });

  it("removing a workspace leaves other groups and session history intact", () => {
    const { store } = createStore();
    const first = store.create({
      name: "One",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_shared", alias: "shared" }],
    });
    const second = store.create({
      name: "Two",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_shared", alias: "shared" }],
    });
    const session = store.createSessionSnapshot(first.id, first.revision, [
      { projectId: "proj_shared", alias: "shared" },
    ]);

    store.remove(first.id, first.revision);

    expect(store.list().map((workspace) => workspace.id)).toEqual([second.id]);
    expect(store.getSession(session.id).workspaceName).toBe("One");
  });

  it("lazily hydrates a legacy session after ordered migrations", () => {
    const db = new Database(":memory:");
    db.exec(WORKSPACE_MIGRATIONS[0]!);
    db.prepare(`INSERT INTO sessions (
      id, workspace_id, workspace_name, workspace_revision, instructions, repositories_json,
      state, request_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "session_legacy", "ws_auth", "Authentication", 1, "",
        JSON.stringify([{ projectId: "proj_auth", alias: "auth" }]),
        "active", "legacy_request", 1, 1,
      );
    WORKSPACE_MIGRATIONS.slice(1).forEach((migration) => db.exec(migration));
    const store = new WorkspaceStore(db);

    expect(store.getSession("session_legacy")).toMatchObject({
      initialRepositories: [{ projectId: "proj_auth", alias: "auth" }],
      expansionPolicy: "ask",
      expansions: [],
      manifestRevision: 1,
    });
  });

  it("appends prepared repositories idempotently without replacing recorded members", () => {
    const { store } = createStore();
    const workspace = store.create({
      name: "Authentication",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth" }],
    });
    const session = store.createSessionSnapshot(
      workspace.id,
      workspace.revision,
      [{ projectId: "proj_auth", alias: "auth" }],
      "session_request",
    );
    store.updateSession(session.id, { threadId: "thr_1", ownerProjectId: "proj_auth" });
    store.setExpansionPolicy(session.id, "auto");
    const first = store.beginExpansion({
      sessionId: session.id,
      projectId: "proj_docs",
      alias: "docs",
      reason: "Documentation is needed",
      requester: "agent",
      approvalMode: "once",
      requestKey: "expansion_request",
    });
    const retried = store.beginExpansion({
      sessionId: session.id,
      projectId: "proj_docs",
      alias: "docs",
      reason: "Documentation is needed",
      requester: "agent",
      approvalMode: "once",
      requestKey: "expansion_request",
    });
    const appended = store.appendProvisionedRepository({
      sessionId: session.id,
      requestKey: "expansion_request",
      repository: { projectId: "proj_docs", alias: "docs", branch: "main" },
      manifestRevision: 2,
    });
    const retriedAppend = store.appendProvisionedRepository({
      sessionId: session.id,
      requestKey: "expansion_request",
      repository: { projectId: "proj_docs", alias: "docs", branch: "main" },
      manifestRevision: 2,
    });

    expect(retried.id).toBe(first.id);
    expect(store.getSessionByThreadId("thr_1")).toMatchObject({ id: session.id, ownerProjectId: "proj_auth" });
    expect(store.hasSessionForThread("thr_1")).toBe(true);
    expect(appended).toMatchObject({
      initialRepositories: [{ projectId: "proj_auth", alias: "auth" }],
      repositories: [
        { projectId: "proj_auth", alias: "auth" },
        { projectId: "proj_docs", alias: "docs", branch: "main" },
      ],
      expansionPolicy: "auto",
      manifestRevision: 2,
      expansions: [{ id: first.id, outcome: "provisioned", requestKey: "expansion_request" }],
    });
    expect(retriedAppend).toEqual(appended);
  });

  it("returns the original session for a retried request key after the workspace changes", () => {
    const { store } = createStore();
    const workspace = store.create({
      name: "Authentication",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth" }],
    });
    const session = store.createSessionSnapshot(
      workspace.id,
      workspace.revision,
      [{ projectId: "proj_auth", alias: "auth" }],
      "retried_session_request",
    );
    store.update(workspace.id, workspace.revision, {
      ...workspace,
      name: "Identity",
    });

    expect(store.createSessionSnapshot(
      workspace.id,
      workspace.revision,
      [{ projectId: "proj_auth", alias: "auth" }],
      "retried_session_request",
    )).toMatchObject({ id: session.id, workspaceName: "Authentication" });
  });

  it("reconciles only manifest additions and never permits membership removal or revision rollback", () => {
    const { store } = createStore();
    const workspace = store.create({
      name: "Platform",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_api", alias: "api" }],
    });
    const session = store.createSessionSnapshot(workspace.id, workspace.revision, [{ projectId: "proj_api", alias: "api" }]);

    const reconciled = store.reconcileRepositories(session.id, [
      { projectId: "proj_api", alias: "api" },
      { projectId: "proj_worker", alias: "worker" },
    ], 2);

    expect(reconciled).toMatchObject({
      manifestRevision: 2,
      repositories: [
        { projectId: "proj_api", alias: "api" },
        { projectId: "proj_worker", alias: "worker" },
      ],
    });
    expect(() => store.reconcileRepositories(session.id, [{ projectId: "proj_worker", alias: "worker" }], 3)).toThrow(/remove|replace|recorded/i);
    expect(() => store.reconcileRepositories(session.id, [
      { projectId: "proj_api", alias: "renamed-api" },
      { projectId: "proj_worker", alias: "worker" },
    ], 3)).toThrow(/replace/i);
    expect(() => store.reconcileRepositories(session.id, reconciled.repositories, 1)).toThrow(/revision/i);
  });

  it("persists plugin metadata and records failed expansion outcomes", () => {
    const { store } = createStore();
    const workspace = store.create({
      name: "Platform",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_api", alias: "api" }],
    });
    const session = store.createSessionSnapshot(workspace.id, workspace.revision, [{ projectId: "proj_api", alias: "api" }]);
    store.setMetadata("welcome", "seen");
    store.beginExpansion({
      sessionId: session.id,
      projectId: "proj_worker",
      alias: "worker",
      reason: "Worker is needed",
      requester: "user",
      approvalMode: "manual",
      requestKey: "failed_expansion",
    });

    expect(store.getMetadata("welcome")).toBe("seen");
    expect(store.getMetadata("missing")).toBeNull();
    expect(store.finishExpansion("failed_expansion", "failed", "provisioning failed")).toMatchObject({
      outcome: "failed",
      error: "provisioning failed",
    });
  });
});
