import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { WorkspaceStore } from "../src/store";

describe("WorkspaceStore", () => {
  it("keeps one repository in multiple workspaces and snapshots sessions", () => {
    const db = new Database(":memory:");
    const store = new WorkspaceStore(db);
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
    const db = new Database(":memory:");
    const store = new WorkspaceStore(db);
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
    const db = new Database(":memory:");
    const store = new WorkspaceStore(db);
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
});
