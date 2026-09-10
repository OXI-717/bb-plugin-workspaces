import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addRepository,
  cleanupSession,
  ensureAnchor,
  prepareSession,
  readRepositoryStatus,
  readSessionManifest,
} from "../src/worktrees";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repository(name: string): { path: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), `bb-workspaces-${name}-`));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "workspaces@example.invalid");
  git(root, "config", "user.name", "Workspaces test");
  writeFileSync(join(root, "README.md"), `${name}\n`);
  git(root, "add", "README.md");
  git(root, "commit", "-m", "base");
  return { path: root, commit: git(root, "rev-parse", "HEAD") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("multi-repository session worktrees", () => {
  it("creates and validates a stable non-Git workspace anchor", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    const anchor = await ensureAnchor(dataRoot);

    expect(anchor.path).toBe(join(dataRoot, "workspace-anchor"));
    expect(JSON.parse(readFileSync(join(anchor.path, ".bb-workspaces-anchor.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      owner: "bb-plugin-workspaces",
    });
    expect(existsSync(join(anchor.path, ".git"))).toBe(false);
    expect(await ensureAnchor(dataRoot)).toEqual(anchor);

    writeFileSync(join(anchor.path, ".bb-workspaces-anchor.json"), JSON.stringify({ schemaVersion: 1, owner: "other" }));
    await expect(ensureAnchor(dataRoot)).rejects.toThrow(/anchor/i);
    expect(existsSync(anchor.path)).toBe(true);
  });

  it("creates isolated worktrees and a compact repository map", async () => {
    const auth = repository("auth");
    const gateway = repository("gateway");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);

    const result = await prepareSession({
      dataRoot,
      sessionId: "session_abc",
      workspaceName: "Authentication",
      instructions: "Run contract tests before finishing.",
      repositories: [
        { projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit },
        { projectId: "proj_gateway", alias: "gateway", sourcePath: gateway.path, baseRef: gateway.commit },
      ],
    });

    expect(readFileSync(join(result.rootPath, "repos/auth/README.md"), "utf8")).toBe("auth\n");
    expect(readFileSync(join(result.rootPath, "repos/gateway/README.md"), "utf8")).toBe("gateway\n");
    expect(readFileSync(join(result.rootPath, "AGENTS.md"), "utf8")).toContain("Run contract tests before finishing.");
    expect(readFileSync(join(result.rootPath, "AGENTS.md"), "utf8")).toContain("`repos/auth` → BB project `proj_auth`");
    expect(git(join(result.rootPath, "repos/auth"), "rev-parse", "HEAD")).toBe(auth.commit);
    expect(git(join(result.rootPath, "repos/gateway"), "rev-parse", "HEAD")).toBe(gateway.commit);
    expect(result.repositories.map((repo) => repo.branch)).toEqual([
      "bb-workspace/session-abc/auth",
      "bb-workspace/session-abc/gateway",
    ]);
    expect(readSessionManifest(dataRoot, "session_abc")).toMatchObject({
      schemaVersion: 2,
      owner: "bb-plugin-workspaces",
      revision: 1,
      operations: [],
      instructions: "Run contract tests before finishing.",
    });
  });

  it("upgrades a valid schema-v1 manifest in memory", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_legacy", workspaceName: "Legacy", instructions: "Keep focused.",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    writeFileSync(join(prepared.rootPath, "session.json"), `${JSON.stringify({
      schemaVersion: 1,
      sessionId: "session_legacy",
      workspaceName: "Legacy",
      repositories: prepared.repositories,
    })}\n`);

    expect(readSessionManifest(dataRoot, "session_legacy")).toMatchObject({
      schemaVersion: 2,
      owner: "bb-plugin-workspaces",
      revision: 1,
      operations: [],
      instructions: "",
      repositories: [{ alias: "auth", worktreePath: join(prepared.rootPath, "repos/auth") }],
    });
  });

  it("adds a repository once and replays duplicate operations without another worktree", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    await prepareSession({
      dataRoot, sessionId: "session_expand", workspaceName: "Expand", instructions: "Keep focused.",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    const request = {
      dataRoot, sessionId: "session_expand", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
    };

    const added = await addRepository(request);
    const replayed = await addRepository(request);
    const duplicateProject = await addRepository({
      ...request,
      operationKey: "expand-audits-2",
      repository: { ...request.repository, alias: "different-alias" },
    });
    const manifest = readSessionManifest(dataRoot, "session_expand");

    expect(manifest.repositories.at(-1)).toMatchObject({ alias: "audits", worktreePath: added.repository.worktreePath });
    expect(replayed).toEqual(added);
    expect(duplicateProject).toEqual(added);
    expect(manifest).toMatchObject({ revision: 2, operations: [{ key: "expand-audits-1", projectId: "proj_audits", alias: "audits" }] });
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-expand/*").split("\n").filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(added.repository.worktreePath, "README.md"), "utf8")).toBe("audits\n");
  });

  it("rejects unsafe additions and manifests that do not prove session ownership", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_validation", workspaceName: "Validation", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });

    await expect(addRepository({
      dataRoot, sessionId: "session_validation", operationKey: "expand-invalid-1",
      repository: { projectId: "proj_audits", alias: "../audits", sourcePath: audits.path, baseRef: "HEAD" },
    })).rejects.toThrow(/alias/i);
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-validation/*")).toBe("");

    const manifestPath = join(prepared.rootPath, "session.json");
    const valid = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...valid, owner: "someone-else" }));
    await expect(addRepository({
      dataRoot, sessionId: "session_validation", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
    })).rejects.toThrow(/owner/i);
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-validation/*")).toBe("");

    writeFileSync(manifestPath, JSON.stringify({ ...valid, owner: undefined }));
    expect(() => readSessionManifest(dataRoot, "session_validation")).toThrow(/owner/i);
  });

  it("atomically replaces the manifest without leaving readable temporary metadata", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_atomic", workspaceName: "Atomic", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });

    await addRepository({
      dataRoot, sessionId: "session_atomic", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
    });

    const manifestPath = join(prepared.rootPath, "session.json");
    expect(readSessionManifest(dataRoot, "session_atomic").revision).toBe(2);
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(prepared.rootPath).filter((name) => name.startsWith(".session.json."))).toEqual([]);
  });

  it("rolls back only a new worktree and branch when manifest publishing fails", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_rollback", workspaceName: "Rollback", instructions: "Keep prior instructions.",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    const priorAgents = readFileSync(join(prepared.rootPath, "AGENTS.md"), "utf8");

    await expect(addRepository({
      dataRoot, sessionId: "session_rollback", operationKey: "expand-audits-1",
      repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" },
      fileOperations: { writeAtomic: async () => { throw new Error("metadata unavailable"); } },
    })).rejects.toThrow(/metadata unavailable/);

    expect(readFileSync(join(prepared.rootPath, "AGENTS.md"), "utf8")).toBe(priorAgents);
    expect(existsSync(join(prepared.rootPath, "repos/audits"))).toBe(false);
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-rollback/audits")).toBe("");
    expect(readSessionManifest(dataRoot, "session_rollback").revision).toBe(1);
  });

  it("serializes concurrent additions for one session into one repository", async () => {
    const auth = repository("auth");
    const audits = repository("audits");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    await prepareSession({
      dataRoot, sessionId: "session_concurrent", workspaceName: "Concurrent", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });

    const results = await Promise.all([
      addRepository({ dataRoot, sessionId: "session_concurrent", operationKey: "expand-audits-1", repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" } }),
      addRepository({ dataRoot, sessionId: "session_concurrent", operationKey: "expand-audits-2", repository: { projectId: "proj_audits", alias: "audits", sourcePath: audits.path, baseRef: "HEAD" } }),
    ]);
    const manifest = readSessionManifest(dataRoot, "session_concurrent");

    expect(results[0]).toEqual(results[1]);
    expect(manifest.repositories.filter((entry) => entry.projectId === "proj_audits")).toHaveLength(1);
    expect(git(audits.path, "branch", "--list", "bb-workspace/session-concurrent/audits").split("\n").filter(Boolean)).toHaveLength(1);
    expect(existsSync(join(dataRoot, "sessions/session_concurrent/repos/audits"))).toBe(true);
  });

  it("reports repository changes independently", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const result = await prepareSession({
      dataRoot,
      sessionId: "session_status",
      workspaceName: "Authentication",
      instructions: "",
      repositories: [
        { projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit },
      ],
    });
    const checkout = result.repositories[0]!.worktreePath;
    writeFileSync(join(checkout, "README.md"), "changed\n");
    mkdirSync(join(checkout, "new folder"));
    writeFileSync(join(checkout, "new folder/file name.txt"), "new\n");

    const status = await readRepositoryStatus(checkout, auth.commit);

    expect(status.changedFiles).toEqual([
      { path: "README.md", status: "modified" },
      { path: "new folder/file name.txt", status: "untracked" },
    ]);
    expect(status.clean).toBe(false);
  });

  it("does not overwrite an unknown session directory", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const target = join(dataRoot, "sessions", "session_collision");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "someone-elses-file"), "keep");

    await expect(prepareSession({
      dataRoot,
      sessionId: "session_collision",
      workspaceName: "Collision",
      instructions: "",
      repositories: [
        { projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit },
      ],
    })).rejects.toThrow(/already exists/i);
    expect(readFileSync(join(target, "someone-elses-file"), "utf8")).toBe("keep");
  });

  it("cleans only unchanged owned worktrees and preserves their branches", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_clean", workspaceName: "Clean", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });

    await cleanupSession({ dataRoot, sessionId: "session_clean", repositories: prepared.repositories });

    expect(() => readFileSync(prepared.rootPath, "utf8")).toThrow();
    expect(git(auth.path, "show-ref", "--verify", "refs/heads/bb-workspace/session-clean/auth")).toContain(auth.commit);
  });

  it("removes a clean worktree with commits and preserves the committed branch tip", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_committed", workspaceName: "Committed", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    const checkout = prepared.repositories[0]!.worktreePath;
    writeFileSync(join(checkout, "README.md"), "committed change\n");
    git(checkout, "add", "README.md");
    git(checkout, "commit", "-m", "change auth");
    const branchTip = git(checkout, "rev-parse", "HEAD");

    const status = await readRepositoryStatus(checkout, auth.commit);
    expect(status).toMatchObject({ clean: true, aheadOfBase: true, changedFiles: [] });
    await cleanupSession({ dataRoot, sessionId: "session_committed", repositories: prepared.repositories });

    expect(git(auth.path, "rev-parse", "refs/heads/bb-workspace/session-committed/auth")).toBe(branchTip);
  });

  it("refuses cleanup when a repository has uncommitted work", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_dirty", workspaceName: "Dirty", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    writeFileSync(join(prepared.repositories[0]!.worktreePath, "README.md"), "unsaved\n");

    await expect(cleanupSession({ dataRoot, sessionId: "session_dirty", repositories: prepared.repositories })).rejects.toThrow(/not clean/i);
    expect(readFileSync(join(prepared.repositories[0]!.worktreePath, "README.md"), "utf8")).toBe("unsaved\n");
  });

  it("refuses cleanup when a worktree was switched to another branch", async () => {
    const auth = repository("auth");
    const dataRoot = mkdtempSync(join(tmpdir(), "bb-workspaces-data-"));
    roots.push(dataRoot);
    const prepared = await prepareSession({
      dataRoot, sessionId: "session_switched", workspaceName: "Switched", instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "auth", sourcePath: auth.path, baseRef: auth.commit }],
    });
    git(prepared.repositories[0]!.worktreePath, "switch", "-c", "unexpected-branch");

    await expect(cleanupSession({ dataRoot, sessionId: "session_switched", repositories: prepared.repositories })).rejects.toThrow(/recorded session branch/i);
  });
});
