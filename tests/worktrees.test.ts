import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSession, prepareSession, readRepositoryStatus } from "../src/worktrees";

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
