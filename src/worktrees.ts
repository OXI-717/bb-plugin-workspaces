import { execFile } from "node:child_process";
import { mkdir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PrepareRepository = {
  projectId: string;
  alias: string;
  sourcePath: string;
  baseRef: string;
};

export type PreparedRepository = PrepareRepository & {
  baseCommit: string;
  branch: string;
  worktreePath: string;
};

export type PreparedSession = {
  rootPath: string;
  repositories: PreparedRepository[];
};

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
};

export type RepositoryStatus = {
  clean: boolean;
  head: string;
  aheadOfBase: boolean;
  changedFiles: ChangedFile[];
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function sessionSlug(sessionId: string): string {
  return sessionId.replace(/^session_/, "session-").replace(/[^a-zA-Z0-9-]/g, "-");
}

function assertSafeAlias(alias: string): void {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(alias)) throw new Error(`Invalid repository alias: ${alias}`);
}

function rootAgents(workspaceName: string, instructions: string, repositories: PrepareRepository[]): string {
  const map = repositories.map((repository) =>
    `- \`repos/${repository.alias}\` → BB project \`${repository.projectId}\``,
  ).join("\n");
  const guidance = instructions.trim() === "" ? "" : `\n## Workspace guidance\n\n${instructions.trim()}\n`;
  return `# ${workspaceName} multi-repository session\n\n` +
    `This task can use only the repositories listed below. Run Git commands inside the relevant repository. ` +
    `Before changing a repository, read the AGENTS.md files that apply inside it.\n\n` +
    `## Repositories\n\n${map}\n${guidance}`;
}

export async function prepareSession(input: {
  dataRoot: string;
  sessionId: string;
  workspaceName: string;
  instructions: string;
  repositories: PrepareRepository[];
}): Promise<PreparedSession> {
  if (input.repositories.length < 1 || input.repositories.length > 20) {
    throw new Error("Select between 1 and 20 repositories");
  }
  const aliases = new Set<string>();
  for (const repository of input.repositories) {
    assertSafeAlias(repository.alias);
    if (aliases.has(repository.alias)) throw new Error(`Duplicate repository alias: ${repository.alias}`);
    aliases.add(repository.alias);
  }

  const sessionsRoot = resolve(input.dataRoot, "sessions");
  const rootPath = resolve(sessionsRoot, input.sessionId);
  if (!rootPath.startsWith(`${sessionsRoot}${sep}`)) throw new Error("Invalid session id");
  await mkdir(sessionsRoot, { recursive: true });
  try {
    await mkdir(rootPath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") throw new Error(`Session directory already exists: ${rootPath}`);
    throw error;
  }

  const reposRoot = join(rootPath, "repos");
  await mkdir(reposRoot);
  const prepared: PreparedRepository[] = [];
  try {
    for (const repository of input.repositories) {
      const sourcePath = resolve(repository.sourcePath);
      const baseCommit = await git(sourcePath, ["rev-parse", "--verify", `${repository.baseRef}^{commit}`]);
      const worktreePath = join(reposRoot, repository.alias);
      const branch = `bb-workspace/${sessionSlug(input.sessionId)}/${repository.alias}`;
      await git(sourcePath, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
      prepared.push({ ...repository, sourcePath, baseCommit, branch, worktreePath });
    }
    const manifest = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      workspaceName: input.workspaceName,
      repositories: prepared,
    };
    await writeFile(join(rootPath, "session.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await writeFile(join(rootPath, "AGENTS.md"), rootAgents(input.workspaceName, input.instructions, input.repositories), { flag: "wx" });
    return { rootPath, repositories: prepared };
  } catch (error) {
    for (const repository of prepared.reverse()) {
      try {
        await git(repository.sourcePath, ["worktree", "remove", repository.worktreePath]);
        await git(repository.sourcePath, ["branch", "-D", repository.branch]);
      } catch {
        // The owned session directory remains for manual recovery when Git refuses cleanup.
      }
    }
    try {
      const entries = await readFile(join(rootPath, "session.json"), "utf8");
      if (entries) return Promise.reject(error);
    } catch {
      await rm(rootPath, { recursive: true, force: true });
    }
    throw error;
  }
}

function mapStatus(code: string): ChangedFile["status"] {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

export async function readRepositoryStatus(worktreePath: string, baseCommit: string): Promise<RepositoryStatus> {
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
  });
  const fields = stdout.toString("utf8").split("\0").filter(Boolean);
  const changedFiles: ChangedFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const code = field.slice(0, 2);
    let path = field.slice(3);
    if (code.includes("R") || code.includes("C")) {
      path = fields[index + 1] ?? path;
      index += 1;
    }
    changedFiles.push({ path, status: mapStatus(code) });
  }
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  const aheadCount = Number(await git(worktreePath, ["rev-list", "--count", `${baseCommit}..HEAD`]));
  return { clean: changedFiles.length === 0, head, aheadOfBase: aheadCount > 0, changedFiles };
}

export async function cleanupSession(input: {
  dataRoot: string;
  sessionId: string;
  repositories: PreparedRepository[];
}): Promise<void> {
  const sessionsRoot = resolve(input.dataRoot, "sessions");
  const rootPath = resolve(sessionsRoot, input.sessionId);
  if (!rootPath.startsWith(`${sessionsRoot}${sep}`)) throw new Error("Invalid session id");

  const manifestPath = join(rootPath, "session.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    sessionId?: unknown;
    repositories?: Array<{ projectId?: unknown; alias?: unknown; worktreePath?: unknown }>;
  };
  if (manifest.sessionId !== input.sessionId || !Array.isArray(manifest.repositories)) {
    throw new Error("Session manifest does not match the requested session");
  }
  if (manifest.repositories.length !== input.repositories.length) {
    throw new Error("Session manifest repository set does not match the cleanup request");
  }

  const reposRoot = join(rootPath, "repos");
  for (const repository of input.repositories) {
    assertSafeAlias(repository.alias);
    const expectedPath = join(reposRoot, repository.alias);
    const recorded = manifest.repositories.find((candidate) =>
      candidate.projectId === repository.projectId && candidate.alias === repository.alias
    );
    if (
      repository.worktreePath !== expectedPath ||
      recorded?.worktreePath !== expectedPath
    ) {
      throw new Error(`Repository ${repository.alias} is outside the owned session directory`);
    }
  }

  // Preflight the entire session before removing anything. A partial cleanup would make
  // recovery harder when another repository still contains work.
  for (const repository of input.repositories) {
    const status = await readRepositoryStatus(repository.worktreePath, repository.baseCommit);
    if (!status.clean) {
      throw new Error(`Repository ${repository.alias} is not clean`);
    }
    const checkedOutBranch = await git(repository.worktreePath, ["symbolic-ref", "--short", "HEAD"]);
    const recordedTip = await git(repository.sourcePath, ["rev-parse", `refs/heads/${repository.branch}`]);
    if (checkedOutBranch !== repository.branch || recordedTip !== status.head) {
      throw new Error(`Repository ${repository.alias} is not on its recorded session branch`);
    }
  }

  for (const repository of input.repositories) {
    await git(repository.sourcePath, ["worktree", "remove", repository.worktreePath]);
  }
  await unlink(join(rootPath, "AGENTS.md"));
  await unlink(manifestPath);
  await rmdir(reposRoot);
  await rmdir(rootPath);
}
