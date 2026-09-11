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
  updateProjectName(projectId: string, name: string): Promise<void>;
};

export const WORKSPACE_PROJECT_NAME = "Workspace Hub";
export const LEGACY_WORKSPACE_PROJECT_NAMES = new Set(["🧩 Workspaces", "🗂️ Workspace Hub"]);

const inFlightByDeps = new WeakMap<WorkspaceProjectDeps, Map<string, Promise<string>>>();
const discoveryLockByDeps = new WeakMap<WorkspaceProjectDeps, Promise<void>>();

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
  return withDiscoveryLock(deps, async () => {
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

    if (LEGACY_WORKSPACE_PROJECT_NAMES.has(project.name)) {
      await deps.updateProjectName(project.id, WORKSPACE_PROJECT_NAME);
    }

    deps.setStoredProjectId(project.id);
    return project.id;
  });
}

export async function renameStoredWorkspaceProject(deps: WorkspaceProjectDeps): Promise<void> {
  const projectId = deps.getStoredProjectId();
  if (!projectId) return;
  const project = await deps.getProject(projectId);
  if (project && LEGACY_WORKSPACE_PROJECT_NAMES.has(project.name)) {
    await deps.updateProjectName(projectId, WORKSPACE_PROJECT_NAME);
  }
}

async function withDiscoveryLock<T>(deps: WorkspaceProjectDeps, operation: () => Promise<T>): Promise<T> {
  let release: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const previous = discoveryLockByDeps.get(deps) ?? Promise.resolve();
  const lock = previous.catch(() => undefined).then(() => gate);
  discoveryLockByDeps.set(deps, lock);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release!();
    if (discoveryLockByDeps.get(deps) === lock) discoveryLockByDeps.delete(deps);
  }
}
