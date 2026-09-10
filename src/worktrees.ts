import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
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

export type SessionManifest = {
  schemaVersion: 2;
  owner: "bb-plugin-workspaces";
  sessionId: string;
  workspaceName: string;
  instructions: string;
  revision: number;
  repositories: PreparedRepository[];
  operations: Array<{ key: string; projectId: string; alias: string }>;
};

export type SessionFileOperations = {
  writeAtomic: (path: string, contents: string) => Promise<void>;
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

function assertSafeSessionId(sessionId: string): void {
  if (!/^session_[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
}

function assertSafeAlias(alias: string): void {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(alias)) throw new Error(`Invalid repository alias: ${alias}`);
}

function sessionPaths(dataRoot: string, sessionId: string): { sessionsRoot: string; rootPath: string; reposRoot: string } {
  assertSafeSessionId(sessionId);
  const sessionsRoot = resolve(dataRoot, "sessions");
  const rootPath = resolve(sessionsRoot, sessionId);
  if (!rootPath.startsWith(`${sessionsRoot}${sep}`)) throw new Error("Invalid session id");
  return { sessionsRoot, rootPath, reposRoot: join(rootPath, "repos") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid session manifest ${field}`);
}

function validatePreparedRepository(value: unknown, rootPath: string, sessionId: string): PreparedRepository {
  if (!isRecord(value)) throw new Error("Invalid session manifest repository");
  assertString(value.projectId, "repository projectId");
  assertString(value.alias, "repository alias");
  assertSafeAlias(value.alias);
  assertString(value.sourcePath, "repository sourcePath");
  assertString(value.baseRef, "repository baseRef");
  assertString(value.baseCommit, "repository baseCommit");
  assertString(value.branch, "repository branch");
  assertString(value.worktreePath, "repository worktreePath");
  const sourcePath = resolve(value.sourcePath);
  const expectedWorktreePath = join(rootPath, "repos", value.alias);
  const expectedBranch = `bb-workspace/${sessionSlug(sessionId)}/${value.alias}`;
  if (value.sourcePath !== sourcePath) throw new Error("Session manifest repository source path is not canonical");
  if (value.worktreePath !== expectedWorktreePath || resolve(value.worktreePath) !== expectedWorktreePath) {
    throw new Error("Session manifest repository path is outside the owned session directory");
  }
  if (value.branch !== expectedBranch) throw new Error("Session manifest repository branch is invalid");
  return {
    projectId: value.projectId,
    alias: value.alias,
    sourcePath,
    baseRef: value.baseRef,
    baseCommit: value.baseCommit,
    branch: value.branch,
    worktreePath: expectedWorktreePath,
  };
}

/** Reads only a validated manifest below the host-owned data root. */
export function readSessionManifest(dataRoot: string, sessionId: string): SessionManifest {
  const { rootPath } = sessionPaths(dataRoot, sessionId);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(rootPath, "session.json"), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read session manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new Error("Invalid session manifest");
  if (raw.sessionId !== sessionId) throw new Error("Session manifest does not match the requested session");
  assertString(raw.workspaceName, "workspaceName");
  if (!Array.isArray(raw.repositories)) throw new Error("Invalid session manifest repositories");
  const repositories = raw.repositories.map((repository) => validatePreparedRepository(repository, rootPath, sessionId));
  const aliases = new Set<string>();
  const projectIds = new Set<string>();
  for (const repository of repositories) {
    if (aliases.has(repository.alias) || projectIds.has(repository.projectId)) {
      throw new Error("Session manifest has duplicate repositories");
    }
    aliases.add(repository.alias);
    projectIds.add(repository.projectId);
  }

  if (raw.schemaVersion === 1) {
    return {
      schemaVersion: 2,
      owner: "bb-plugin-workspaces",
      sessionId,
      workspaceName: raw.workspaceName,
      instructions: "",
      revision: 1,
      repositories,
      operations: [],
    };
  }
  if (raw.schemaVersion !== 2 || raw.owner !== "bb-plugin-workspaces") {
    throw new Error("Session manifest ownership marker is invalid");
  }
  if (typeof raw.instructions !== "string" || typeof raw.revision !== "number" ||
    !Number.isInteger(raw.revision) || raw.revision < 1 || !Array.isArray(raw.operations)) {
    throw new Error("Invalid session manifest metadata");
  }
  const operations = raw.operations.map((operation) => {
    if (!isRecord(operation)) throw new Error("Invalid session manifest operation");
    assertString(operation.key, "operation key");
    assertString(operation.projectId, "operation projectId");
    assertString(operation.alias, "operation alias");
    assertSafeAlias(operation.alias);
    const repository = repositories.find((candidate) => candidate.projectId === operation.projectId);
    if (!repository || repository.alias !== operation.alias) throw new Error("Session manifest operation does not match a repository");
    return { key: operation.key, projectId: operation.projectId, alias: operation.alias };
  });
  if (new Set(operations.map((operation) => operation.key)).size !== operations.length) {
    throw new Error("Session manifest has duplicate operation keys");
  }
  return {
    schemaVersion: 2,
    owner: "bb-plugin-workspaces",
    sessionId,
    workspaceName: raw.workspaceName,
    instructions: raw.instructions,
    revision: raw.revision,
    repositories,
    operations,
  };
}

export async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function ensureAnchor(dataRoot: string): Promise<{ path: string }> {
  const anchorPath = join(resolve(dataRoot), "workspace-anchor");
  const markerPath = join(anchorPath, ".bb-workspaces-anchor.json");
  const marker = `${JSON.stringify({ schemaVersion: 1, owner: "bb-plugin-workspaces" })}\n`;
  await mkdir(anchorPath, { recursive: true });
  try {
    await writeFile(markerPath, marker, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
    let existing: unknown;
    try {
      existing = JSON.parse(await readFile(markerPath, "utf8"));
    } catch {
      throw new Error("Workspace anchor marker is invalid");
    }
    if (!isRecord(existing) || existing.schemaVersion !== 1 || existing.owner !== "bb-plugin-workspaces") {
      throw new Error("Workspace anchor marker is invalid");
    }
  }
  return { path: anchorPath };
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
  assertSafeSessionId(input.sessionId);
  if (input.repositories.length < 1 || input.repositories.length > 20) {
    throw new Error("Select between 1 and 20 repositories");
  }
  const aliases = new Set<string>();
  for (const repository of input.repositories) {
    assertSafeAlias(repository.alias);
    if (aliases.has(repository.alias)) throw new Error(`Duplicate repository alias: ${repository.alias}`);
    aliases.add(repository.alias);
  }

  const { sessionsRoot, rootPath, reposRoot } = sessionPaths(input.dataRoot, input.sessionId);
  await mkdir(sessionsRoot, { recursive: true });
  try {
    await mkdir(rootPath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") throw new Error(`Session directory already exists: ${rootPath}`);
    throw error;
  }

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
    const manifest: SessionManifest = {
      schemaVersion: 2,
      owner: "bb-plugin-workspaces",
      sessionId: input.sessionId,
      workspaceName: input.workspaceName,
      instructions: input.instructions,
      revision: 1,
      repositories: prepared,
      operations: [],
    };
    await writeAtomic(join(rootPath, "session.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(rootPath, "AGENTS.md"), rootAgents(input.workspaceName, input.instructions, prepared), {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
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

const sessionQueues = new Map<string, Promise<void>>();

async function serializeSession<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const completion = new Promise<void>((resolveCompletion) => { release = resolveCompletion; });
  const tail = previous.then(() => completion);
  sessionQueues.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionQueues.get(key) === tail) sessionQueues.delete(key);
  }
}

function validateRequestedRepository(repository: PrepareRepository): PrepareRepository {
  assertString(repository.projectId, "repository projectId");
  assertSafeAlias(repository.alias);
  assertString(repository.sourcePath, "repository sourcePath");
  assertString(repository.baseRef, "repository baseRef");
  const sourcePath = resolve(repository.sourcePath);
  if (repository.sourcePath !== sourcePath) throw new Error("Repository source path is not canonical");
  return { ...repository, sourcePath };
}

export async function addRepository(input: {
  dataRoot: string;
  sessionId: string;
  operationKey: string;
  repository: PrepareRepository;
  /** Testable failure seam for the final manifest publication only. */
  fileOperations?: SessionFileOperations;
}): Promise<{ repository: PreparedRepository; manifestRevision: number }> {
  assertSafeSessionId(input.sessionId);
  assertString(input.operationKey, "operation key");
  const repository = validateRequestedRepository(input.repository);
  const { rootPath, reposRoot } = sessionPaths(input.dataRoot, input.sessionId);
  const queueKey = `${resolve(input.dataRoot)}:${input.sessionId}`;
  return serializeSession(queueKey, async () => {
    const manifest = readSessionManifest(input.dataRoot, input.sessionId);
    const replayedOperation = manifest.operations.find((operation) => operation.key === input.operationKey);
    if (replayedOperation) {
      const existing = manifest.repositories.find((candidate) => candidate.projectId === replayedOperation.projectId);
      if (!existing) throw new Error("Session manifest operation does not have a repository");
      return { repository: existing, manifestRevision: manifest.revision };
    }
    const existingRepository = manifest.repositories.find((candidate) => candidate.projectId === repository.projectId);
    if (existingRepository) return { repository: existingRepository, manifestRevision: manifest.revision };
    if (manifest.repositories.some((candidate) => candidate.alias === repository.alias)) {
      throw new Error(`Duplicate repository alias: ${repository.alias}`);
    }

    const worktreePath = join(reposRoot, repository.alias);
    const branch = `bb-workspace/${sessionSlug(input.sessionId)}/${repository.alias}`;
    const baseCommit = await git(repository.sourcePath, ["rev-parse", "--verify", `${repository.baseRef}^{commit}`]);
    const prepared: PreparedRepository = { ...repository, baseCommit, branch, worktreePath };
    let worktreeCreated = false;
    let branchCreated = false;
    const agentsPath = join(rootPath, "AGENTS.md");
    const priorAgents = await readFile(agentsPath, "utf8");
    try {
      await git(repository.sourcePath, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
      worktreeCreated = true;
      branchCreated = true;
      const nextManifest: SessionManifest = {
        ...manifest,
        revision: manifest.revision + 1,
        repositories: [...manifest.repositories, prepared],
        operations: [...manifest.operations, { key: input.operationKey, projectId: repository.projectId, alias: repository.alias }],
      };
      await writeAtomic(agentsPath, rootAgents(manifest.workspaceName, manifest.instructions, nextManifest.repositories));
      await (input.fileOperations?.writeAtomic ?? writeAtomic)(
        join(rootPath, "session.json"),
        `${JSON.stringify(nextManifest, null, 2)}\n`,
      );
      return { repository: prepared, manifestRevision: nextManifest.revision };
    } catch (error) {
      if (worktreeCreated) {
        await writeAtomic(agentsPath, priorAgents).catch(() => undefined);
        await git(repository.sourcePath, ["worktree", "remove", worktreePath]).catch(() => undefined);
      }
      if (branchCreated) await git(repository.sourcePath, ["branch", "-D", branch]).catch(() => undefined);
      throw error;
    }
  });
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
  const { rootPath, reposRoot } = sessionPaths(input.dataRoot, input.sessionId);
  const manifestPath = join(rootPath, "session.json");
  const manifest = readSessionManifest(input.dataRoot, input.sessionId);
  if (manifest.repositories.length !== input.repositories.length) {
    throw new Error("Session manifest repository set does not match the cleanup request");
  }

  for (const repository of input.repositories) {
    assertSafeAlias(repository.alias);
    const expectedPath = join(reposRoot, repository.alias);
    const recorded = manifest.repositories.find((candidate) =>
      candidate.projectId === repository.projectId && candidate.alias === repository.alias
    );
    if (!recorded || repository.worktreePath !== expectedPath || recorded.worktreePath !== expectedPath ||
      repository.sourcePath !== recorded.sourcePath || repository.branch !== recorded.branch ||
      repository.baseCommit !== recorded.baseCommit) {
      throw new Error(`Repository ${repository.alias} is outside the owned session directory`);
    }
  }

  // Preflight the entire session before removing anything. A partial cleanup would make
  // recovery harder when another repository still contains work.
  for (const repository of manifest.repositories) {
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

  for (const repository of manifest.repositories) {
    await git(repository.sourcePath, ["worktree", "remove", repository.worktreePath]);
  }
  await unlink(join(rootPath, "AGENTS.md"));
  await unlink(manifestPath);
  await rmdir(reposRoot);
  await rmdir(rootPath);
}
