import { z } from "zod";
import {
  expansionApprovalPayloadSchema,
  expansionApprovalResponseSchema,
  type ExpansionApprovalMode,
  type SessionExpansion,
  type SessionRepository,
  type SessionSnapshot,
} from "./contracts";
import type { WorkspaceStore } from "./store";

export type ExpansionProject = {
  id: string;
  name: string;
  sources: Array<{ id: string; hostId: string; path: string; isDefault: boolean }>;
};

export type ExpansionOption = {
  projectId: string;
  alias: string;
  projectName: string;
  sourcePath: string;
};

export type ExpansionHostRepository = SessionRepository & {
  sourcePath: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  worktreePath: string;
};

export type SessionManifest = {
  revision: number;
  repositories: ExpansionHostRepository[];
};

export type SessionExpansionDeps = {
  store: WorkspaceStore;
  listProjects(): Promise<ExpansionProject[]>;
  requestApproval(payload: z.infer<typeof expansionApprovalPayloadSchema>, signal?: AbortSignal): Promise<unknown>;
  addRepository(
    input: { sessionId: string; operationKey: string; repository: { projectId: string; alias: string; sourcePath: string; baseRef: string } },
    hostId: string,
  ): Promise<{ repository: ExpansionHostRepository; manifestRevision: number }>;
  readSession(sessionId: string, hostId: string): Promise<SessionManifest>;
  publishChanged(): Promise<void>;
};

export type AgentExpansionRequest = {
  threadId: string;
  alias: string;
  reason: string;
  requestKey: string;
  signal?: AbortSignal;
};

export type ManualExpansionRequest = {
  threadId: string;
  projectId: string;
  requestKey: string;
};

export type ExpansionResult = {
  added: boolean;
  alias: string;
  policy: "ask" | "auto";
  cancelled?: boolean;
  pending?: boolean;
  recovered?: boolean;
  error?: string;
};

const requestKeySchema = z.string().min(8).max(200);
const reasonSchema = z.string().min(1).max(2_000);

/** Resolves untrusted requests and owns the complete expansion state machine. */
export class SessionExpansionService {
  constructor(private readonly deps: SessionExpansionDeps) {}

  async optionsForThread(threadId: string): Promise<ExpansionOption[]> {
    const session = this.deps.store.getSessionByThreadId(threadId);
    if (!session) throw new Error("This thread is not a workspace session");
    return this.optionsForSession(session);
  }

  async requestFromAgent(input: AgentExpansionRequest): Promise<ExpansionResult> {
    requestKeySchema.parse(input.requestKey);
    reasonSchema.parse(input.reason);
    const replay = this.deps.store.getExpansionByRequestKey(input.requestKey);
    if (replay) return this.resultForReplay(replay);

    const session = this.sessionForThread(input.threadId);
    const option = (await this.optionsForSession(session)).find((candidate) => candidate.alias === input.alias);
    if (!option) throw new Error(`Repository alias ${input.alias} is not eligible for this session`);

    let approvalMode: ExpansionApprovalMode = "once";
    this.deps.store.beginExpansion({
      sessionId: session.id, projectId: option.projectId, alias: option.alias, reason: input.reason,
      requester: "agent", approvalMode, requestKey: input.requestKey,
    });

    try {
      if (session.expansionPolicy === "ask") {
        const response = expansionApprovalResponseSchema.parse(await this.deps.requestApproval(expansionApprovalPayloadSchema.parse({
          sessionId: session.id,
          workspaceName: session.workspaceName,
          repositoryAlias: option.alias,
          repositoryName: option.projectName,
          reason: input.reason,
        }), input.signal));
        if (response.action === "cancel") return this.cancel(input.requestKey, option.alias);
        if (response.action === "add-and-auto") {
          approvalMode = "auto";
          this.deps.store.setExpansionPolicy(session.id, "auto");
          this.replacePendingApprovalMode(input.requestKey, approvalMode);
        }
      } else {
        approvalMode = "auto";
        this.replacePendingApprovalMode(input.requestKey, approvalMode);
      }
      return await this.provision(session, option, input.requestKey, approvalMode);
    } catch (error) {
      return this.fail(input.requestKey, option.alias, error);
    }
  }

  async addManually(input: ManualExpansionRequest): Promise<ExpansionResult> {
    requestKeySchema.parse(input.requestKey);
    const replay = this.deps.store.getExpansionByRequestKey(input.requestKey);
    if (replay) return this.resultForReplay(replay);

    const session = this.sessionForThread(input.threadId);
    const option = (await this.optionsForSession(session)).find((candidate) => candidate.projectId === input.projectId);
    if (!option) throw new Error(`Project ${input.projectId} is not eligible for this session`);
    this.deps.store.beginExpansion({
      sessionId: session.id, projectId: option.projectId, alias: option.alias,
      reason: "Added manually by a workspace member.", requester: "user", approvalMode: "manual", requestKey: input.requestKey,
    });
    try {
      return await this.provision(session, option, input.requestKey, "manual");
    } catch (error) {
      return this.fail(input.requestKey, option.alias, error);
    }
  }

  async reconcileSession(sessionId: string): Promise<SessionSnapshot> {
    const session = this.deps.store.getSession(sessionId);
    if (!session.hostId) throw new Error("Session host is unavailable");
    const manifest = await this.deps.readSession(session.id, session.hostId);
    return this.deps.store.reconcileRepositories(session.id, manifest.repositories, manifest.revision);
  }

  async reconcileActiveSessions(): Promise<SessionSnapshot[]> {
    const active = this.deps.store.listSessions().filter((session) => session.state === "active" && session.hostId);
    return Promise.all(active.map((session) => this.reconcileSession(session.id)));
  }

  private sessionForThread(threadId: string): SessionSnapshot {
    const session = this.deps.store.getSessionByThreadId(threadId);
    if (!session) throw new Error("This thread is not a workspace session");
    if (session.state !== "active") throw new Error("Only active workspace sessions can add repositories");
    if (!session.hostId) throw new Error("Session host is unavailable");
    return session;
  }

  private async optionsForSession(session: SessionSnapshot): Promise<ExpansionOption[]> {
    if (session.state !== "active") throw new Error("Only active workspace sessions can add repositories");
    if (!session.workspaceId) throw new Error("The saved workspace is unavailable");
    if (!session.hostId) throw new Error("Session host is unavailable");
    let workspace;
    try {
      workspace = this.deps.store.get(session.workspaceId);
    } catch {
      throw new Error("The saved workspace no longer exists");
    }
    const projects = new Map((await this.deps.listProjects()).map((project) => [project.id, project]));
    const present = new Set(session.repositories.map((repository) => repository.projectId));
    return workspace.repositories.flatMap((repository) => {
      if (present.has(repository.projectId)) return [];
      const project = projects.get(repository.projectId);
      if (!project) return [];
      const source = project.sources.find((candidate) => candidate.hostId === session.hostId && candidate.isDefault)
        ?? project.sources.find((candidate) => candidate.hostId === session.hostId);
      return source ? [{ projectId: project.id, alias: repository.alias, projectName: project.name, sourcePath: source.path }] : [];
    });
  }

  private async provision(session: SessionSnapshot, option: ExpansionOption, requestKey: string, _approvalMode: ExpansionApprovalMode): Promise<ExpansionResult> {
    const hostId = session.hostId!;
    const added = await this.deps.addRepository({
      sessionId: session.id,
      operationKey: requestKey,
      repository: { projectId: option.projectId, alias: option.alias, sourcePath: option.sourcePath, baseRef: "HEAD" },
    }, hostId);
    try {
      this.deps.store.appendProvisionedRepository({
        sessionId: session.id, requestKey, repository: added.repository, manifestRevision: added.manifestRevision,
      });
      await this.publishTerminal();
      return { added: true, alias: option.alias, policy: this.deps.store.getSession(session.id).expansionPolicy };
    } catch (recordingError) {
      try {
        const repaired = await this.reconcileSession(session.id);
        const recorded = repaired.repositories.find((repository) => repository.projectId === option.projectId && repository.alias === option.alias);
        if (!recorded) throw new Error("The host manifest did not contain the provisioned repository");
        this.deps.store.finishProvisionedExpansion(requestKey);
        await this.publishTerminal();
        return { added: true, alias: option.alias, policy: repaired.expansionPolicy, recovered: true };
      } catch (recoveryError) {
        const message = `Repository ${option.alias} exists on disk pending database recovery: ${this.message(recordingError)}; ${this.message(recoveryError)}`;
        return this.fail(requestKey, option.alias, new Error(message));
      }
    }
  }

  private async cancel(requestKey: string, alias: string): Promise<ExpansionResult> {
    const expansion = this.deps.store.finishExpansion(requestKey, "cancelled");
    await this.publishTerminal();
    return { added: false, alias, policy: this.deps.store.getSession(expansion.sessionId).expansionPolicy, cancelled: true };
  }

  private async fail(requestKey: string, alias: string, error: unknown): Promise<ExpansionResult> {
    const expansion = this.deps.store.finishExpansion(requestKey, "failed", this.message(error));
    await this.publishTerminal();
    return { added: false, alias, policy: this.deps.store.getSession(expansion.sessionId).expansionPolicy, error: this.message(error) };
  }

  private async publishTerminal(): Promise<void> {
    await this.deps.publishChanged();
  }

  private resultForReplay(expansion: SessionExpansion): ExpansionResult {
    const policy = this.deps.store.getSession(expansion.sessionId).expansionPolicy;
    if (expansion.outcome === "provisioned") return { added: true, alias: expansion.alias, policy };
    if (expansion.outcome === "cancelled") return { added: false, alias: expansion.alias, policy, cancelled: true };
    if (expansion.outcome === "pending") return { added: false, alias: expansion.alias, policy, pending: true };
    return { added: false, alias: expansion.alias, policy, error: expansion.error ?? "Expansion failed" };
  }

  private replacePendingApprovalMode(requestKey: string, approvalMode: ExpansionApprovalMode): void {
    const expansion = this.deps.store.getExpansionByRequestKey(requestKey);
    if (!expansion || expansion.approvalMode === approvalMode) return;
    this.deps.store.setExpansionApprovalMode(requestKey, approvalMode);
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
