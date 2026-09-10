import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  workspaceDraftSchema,
  type RepositoryDraft,
  type SessionRepository,
  type SessionSnapshot,
  type Workspace,
  type WorkspaceDraft,
} from "./contracts";

type WorkspaceRow = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  revision: number;
  pinned: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

type RepoRow = { project_id: string; alias: string; ordinal: number };

type SessionRow = {
  id: string;
  workspace_id: string | null;
  workspace_name: string;
  workspace_revision: number;
  instructions: string;
  repositories_json: string;
  state: SessionSnapshot["state"];
  host_id: string | null;
  root_path: string | null;
  primary_project_id: string | null;
  thread_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  request_key: string;
};

export const WORKSPACE_MIGRATIONS = [`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    revision INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_repositories (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, project_id),
    UNIQUE (workspace_id, alias)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    workspace_name TEXT NOT NULL,
    workspace_revision INTEGER NOT NULL,
    instructions TEXT NOT NULL,
    repositories_json TEXT NOT NULL,
    state TEXT NOT NULL,
    host_id TEXT,
    root_path TEXT,
    primary_project_id TEXT,
    thread_id TEXT,
    error TEXT,
    request_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`];

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(WORKSPACE_MIGRATIONS[0]!);
  }

  list(includeArchived = false): Workspace[] {
    const rows = this.db.prepare(
      `SELECT * FROM workspaces ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY pinned DESC, updated_at DESC, name ASC`,
    ).all() as WorkspaceRow[];
    return rows.map((row) => this.hydrate(row));
  }

  get(id: string): Workspace {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    if (!row) throw new Error(`Workspace ${id} was not found`);
    return this.hydrate(row);
  }

  create(input: WorkspaceDraft): Workspace {
    const draft = workspaceDraftSchema.parse(input);
    const now = Date.now();
    const id = `ws_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO workspaces
        (id, name, description, instructions, revision, pinned, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?)`)
        .run(id, draft.name, draft.description, draft.instructions, now, now);
      this.replaceRepositories(id, draft.repositories);
    })();
    return this.get(id);
  }

  update(id: string, expectedRevision: number, input: WorkspaceDraft): Workspace {
    const draft = workspaceDraftSchema.parse(input);
    const now = Date.now();
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE workspaces
        SET name = ?, description = ?, instructions = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?`)
        .run(draft.name, draft.description, draft.instructions, now, id, expectedRevision);
      if (result.changes !== 1) throw new Error("Workspace revision is stale or the workspace no longer exists");
      this.replaceRepositories(id, draft.repositories);
    })();
    return this.get(id);
  }

  setPinned(id: string, expectedRevision: number, pinned: boolean): Workspace {
    return this.patchFlag(id, expectedRevision, "pinned", pinned ? 1 : 0);
  }

  setArchived(id: string, expectedRevision: number, archived: boolean): Workspace {
    return this.patchFlag(id, expectedRevision, "archived_at", archived ? Date.now() : null);
  }

  remove(id: string, expectedRevision: number): void {
    const result = this.db.prepare("DELETE FROM workspaces WHERE id = ? AND revision = ?").run(id, expectedRevision);
    if (result.changes !== 1) throw new Error("Workspace revision is stale or the workspace no longer exists");
  }

  createSessionSnapshot(workspaceId: string, expectedRevision: number, repositories: RepositoryDraft[], requestKey: string = randomUUID()): SessionSnapshot {
    const workspace = this.get(workspaceId);
    if (workspace.revision !== expectedRevision) throw new Error("Workspace revision is stale");
    const allowed = new Map(workspace.repositories.map((repository) => [repository.projectId, repository.alias]));
    if (repositories.length < 1 || repositories.length > 20) throw new Error("Select between 1 and 20 repositories");
    const selected = repositories.map((repository) => {
      if (allowed.get(repository.projectId) !== repository.alias) {
        throw new Error(`Repository ${repository.projectId} is not in this workspace with alias ${repository.alias}`);
      }
      return repository;
    });
    const now = Date.now();
    const id = `session_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.db.prepare(`INSERT INTO sessions
      (id, workspace_id, workspace_name, workspace_revision, instructions, repositories_json,
       state, request_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
      .run(id, workspace.id, workspace.name, workspace.revision, workspace.instructions, JSON.stringify(selected), requestKey, now, now);
    return this.getSession(id);
  }

  getSessionByRequestKey(requestKey: string): SessionSnapshot | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE request_key = ?").get(requestKey) as SessionRow | undefined;
    return row ? this.hydrateSession(row) : null;
  }

  getSession(id: string): SessionSnapshot {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw new Error(`Session ${id} was not found`);
    return this.hydrateSession(row);
  }

  listSessions(workspaceId?: string): SessionSnapshot[] {
    const rows = (workspaceId
      ? this.db.prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at DESC").all(workspaceId)
      : this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all()) as SessionRow[];
    return rows.map((row) => this.hydrateSession(row));
  }

  updateSession(id: string, patch: Partial<Pick<SessionSnapshot, "state" | "hostId" | "rootPath" | "primaryProjectId" | "threadId" | "error">>): SessionSnapshot {
    const current = this.getSession(id);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db.prepare(`UPDATE sessions SET state = ?, host_id = ?, root_path = ?, primary_project_id = ?,
      thread_id = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(next.state, next.hostId, next.rootPath, next.primaryProjectId, next.threadId, next.error, next.updatedAt, id);
    return this.getSession(id);
  }

  setSessionRepositories(id: string, repositories: SessionRepository[]): SessionSnapshot {
    const result = this.db.prepare("UPDATE sessions SET repositories_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(repositories), Date.now(), id);
    if (result.changes !== 1) throw new Error(`Session ${id} was not found`);
    return this.getSession(id);
  }

  private replaceRepositories(workspaceId: string, repositories: RepositoryDraft[]): void {
    this.db.prepare("DELETE FROM workspace_repositories WHERE workspace_id = ?").run(workspaceId);
    const insert = this.db.prepare("INSERT INTO workspace_repositories (workspace_id, project_id, alias, ordinal) VALUES (?, ?, ?, ?)");
    repositories.forEach((repository, ordinal) => insert.run(workspaceId, repository.projectId, repository.alias, ordinal));
  }

  private patchFlag(id: string, expectedRevision: number, column: "pinned" | "archived_at", value: number | null): Workspace {
    const result = this.db.prepare(`UPDATE workspaces SET ${column} = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(value, Date.now(), id, expectedRevision);
    if (result.changes !== 1) throw new Error("Workspace revision is stale or the workspace no longer exists");
    return this.get(id);
  }

  private hydrate(row: WorkspaceRow): Workspace {
    const repositories = this.db.prepare(`SELECT project_id, alias, ordinal FROM workspace_repositories
      WHERE workspace_id = ? ORDER BY ordinal`).all(row.id) as RepoRow[];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      revision: row.revision,
      pinned: row.pinned === 1,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      repositories: repositories.map((repository) => ({
        projectId: repository.project_id,
        alias: repository.alias,
        ordinal: repository.ordinal,
      })),
    };
  }

  private hydrateSession(row: SessionRow): SessionSnapshot {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      workspaceRevision: row.workspace_revision,
      instructions: row.instructions,
      repositories: JSON.parse(row.repositories_json) as SessionRepository[],
      state: row.state,
      hostId: row.host_id,
      rootPath: row.root_path,
      primaryProjectId: row.primary_project_id,
      threadId: row.thread_id,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
