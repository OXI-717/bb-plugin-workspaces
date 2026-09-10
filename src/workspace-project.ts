export type ProjectRecord = {
  id: string;
  name: string;
  sources: Array<{ id: string; hostId: string; path: string; isDefault: boolean }>;
};

export type LocalPathSourceInput = {
  type: "local_path";
  hostId: string;
  path: string;
};

export type CreateProjectInput = {
  name: string;
  source: LocalPathSourceInput;
};

export type WorkspaceProjectDeps = {
  getStoredProjectId(): string | null;
  setStoredProjectId(id: string): void;
  ensureAnchor(hostId: string): Promise<{ path: string }>;
  getProject(id: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  addSource(projectId: string, input: LocalPathSourceInput): Promise<void>;
};

export const WORKSPACE_PROJECT_NAME = "🧩 Workspaces";

const inFlightByDeps = new WeakMap<WorkspaceProjectDeps, Map<string, Promise<string>>>();

export function ensureWorkspaceProject(deps: WorkspaceProjectDeps, hostId: string): Promise<string> {
  let inFlight = inFlightByDeps.get(deps);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByDeps.set(deps, inFlight);
  }
  const existing = inFlight.get(hostId);
  if (existing) return existing;
  const ensure = resolveWorkspaceProject(deps, hostId).finally(() => inFlight!.delete(hostId));
  inFlight.set(hostId, ensure);
  return ensure;
}

async function resolveWorkspaceProject(deps: WorkspaceProjectDeps, hostId: string): Promise<string> {
  const anchor = await deps.ensureAnchor(hostId);
  const source: LocalPathSourceInput = { type: "local_path", hostId, path: anchor.path };
  const storedId = deps.getStoredProjectId();
  let project = storedId ? await deps.getProject(storedId) : null;

  if (!project) {
    project = (await deps.listProjects()).find((candidate) => candidate.sources.some(
      (candidateSource) => candidateSource.hostId === hostId && candidateSource.path === anchor.path,
    )) ?? null;
  }

  if (!project) {
    project = await deps.createProject({ name: WORKSPACE_PROJECT_NAME, source });
  } else if (!project.sources.some((candidate) => candidate.hostId === hostId && candidate.path === anchor.path)) {
    await deps.addSource(project.id, source);
  }

  deps.setStoredProjectId(project.id);
  return project.id;
}
