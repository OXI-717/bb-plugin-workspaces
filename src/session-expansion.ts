import { z } from "zod";
import { expansionApprovalPayloadSchema, expansionApprovalResponseSchema, type SessionExpansion, type SessionRepository, type SessionSnapshot } from "./contracts";
import type { WorkspaceStore } from "./store";

export type ExpansionProject = { id: string; name: string; sources: Array<{ id: string; hostId: string; path: string; isDefault: boolean }> };
export type ExpansionOption = { projectId: string; alias: string; projectName: string; sourcePath: string };
export type ExpansionHostRepository = SessionRepository & { sourcePath: string; baseRef: string; baseCommit: string; branch: string; worktreePath: string };
export type SessionManifest = { revision: number; repositories: ExpansionHostRepository[]; operations: Array<{ key: string; projectId: string; alias: string }> };
export type SessionExpansionDeps = {
  store: WorkspaceStore;
  listProjects(): Promise<ExpansionProject[]>;
  requestApproval(payload: z.infer<typeof expansionApprovalPayloadSchema>, signal?: AbortSignal): Promise<unknown>;
  addRepository(input: { sessionId: string; operationKey: string; repository: { projectId: string; alias: string; sourcePath: string; baseRef: string } }, hostId: string): Promise<{ repository: ExpansionHostRepository; manifestRevision: number }>;
  readSession(sessionId: string, hostId: string): Promise<SessionManifest>;
  publishChanged(): Promise<void>;
  reportError?(input: { operation: "workspaces-changed"; sessionId: string; error: string }): void;
};
export type AgentExpansionRequest = { threadId: string; alias: string; reason: string; requestKey: string; signal?: AbortSignal };
export type ManualExpansionRequest = { threadId: string; projectId: string; requestKey: string };
export type ExpansionResult = { added: boolean; alias: string; policy: "ask" | "auto"; cancelled?: boolean; pending?: boolean; recovered?: boolean; error?: string };
export type ActiveReconciliationResult = { sessionId: string; session?: SessionSnapshot; error?: string };

const requestKeySchema = z.string().min(8).max(200);
const reasonSchema = z.string().min(1).max(2_000);

/** Resolves untrusted requests and owns the complete expansion state machine. */
export class SessionExpansionService {
  private readonly inFlight = new Map<string, Promise<ExpansionResult>>();

  constructor(private readonly deps: SessionExpansionDeps) {}

  async optionsForThread(threadId: string): Promise<ExpansionOption[]> {
    const session = this.deps.store.getSessionByThreadId(threadId);
    if (!session) throw new Error("This thread is not a workspace session");
    return this.optionsForSession(session);
  }

  requestFromAgent(input: AgentExpansionRequest): Promise<ExpansionResult> {
    requestKeySchema.parse(input.requestKey);
    reasonSchema.parse(input.reason);
    return this.runOnce(input.requestKey, () => this.requestFromAgentOnce(input));
  }

  addManually(input: ManualExpansionRequest): Promise<ExpansionResult> {
    requestKeySchema.parse(input.requestKey);
    return this.runOnce(input.requestKey, () => this.addManuallyOnce(input));
  }

  async reconcileSession(sessionId: string): Promise<SessionSnapshot> {
    const { snapshot } = await this.readAndReconcile(this.deps.store.getSession(sessionId));
    return snapshot;
  }

  async reconcileActiveSessions(): Promise<ActiveReconciliationResult[]> {
    const results: ActiveReconciliationResult[] = [];
    for (const session of this.deps.store.listSessions()) {
      if (session.state !== "active" || !session.hostId) continue;
      try {
        results.push({ sessionId: session.id, session: await this.reconcileSession(session.id) });
      } catch (error) {
        results.push({ sessionId: session.id, error: this.message(error) });
      }
    }
    return results;
  }

  private async requestFromAgentOnce(input: AgentExpansionRequest): Promise<ExpansionResult> {
    const replay = this.deps.store.getExpansionByRequestKey(input.requestKey);
    if (replay) return this.replay(replay);
    const session = this.sessionForThread(input.threadId);
    const option = (await this.optionsForSession(session)).find((candidate) => candidate.alias === input.alias);
    if (!option) throw new Error(`Repository alias ${input.alias} is not eligible for this session`);
    const claim = this.deps.store.claimExpansion({ sessionId: session.id, projectId: option.projectId, alias: option.alias, reason: input.reason, requester: "agent", approvalMode: "once", requestKey: input.requestKey });
    if (!claim.claimed) return this.replay(claim.expansion);
    try {
      if (this.deps.store.getSession(session.id).expansionPolicy === "ask") {
        let response;
        try {
          response = expansionApprovalResponseSchema.parse(await this.deps.requestApproval(expansionApprovalPayloadSchema.parse({
            sessionId: session.id, workspaceName: session.workspaceName, repositoryAlias: option.alias, repositoryName: option.projectName, reason: input.reason,
          }), input.signal));
        } catch (error) {
          if (this.isAbort(error)) return this.terminal(this.cancel(input.requestKey, option.alias), session.id);
          throw error;
        }
        if (response.action === "cancel") return this.terminal(this.cancel(input.requestKey, option.alias), session.id);
        if (response.action === "add-and-auto") {
          this.deps.store.setExpansionPolicy(session.id, "auto");
          this.deps.store.setExpansionApprovalMode(input.requestKey, "auto");
        }
      } else {
        this.deps.store.setExpansionApprovalMode(input.requestKey, "auto");
      }
      const result = await this.provision(session.id, option, input.requestKey);
      return result.pending ? result : this.terminal(result, session.id);
    } catch (error) {
      return this.terminal(this.fail(input.requestKey, option.alias, error), session.id);
    }
  }

  private async addManuallyOnce(input: ManualExpansionRequest): Promise<ExpansionResult> {
    const replay = this.deps.store.getExpansionByRequestKey(input.requestKey);
    if (replay) return this.replay(replay);
    const session = this.sessionForThread(input.threadId);
    const option = (await this.optionsForSession(session)).find((candidate) => candidate.projectId === input.projectId);
    if (!option) throw new Error(`Project ${input.projectId} is not eligible for this session`);
    const claim = this.deps.store.claimExpansion({ sessionId: session.id, projectId: option.projectId, alias: option.alias, reason: "Added manually by a workspace member.", requester: "user", approvalMode: "manual", requestKey: input.requestKey });
    if (!claim.claimed) return this.replay(claim.expansion);
    try {
      const result = await this.provision(session.id, option, input.requestKey);
      return result.pending ? result : this.terminal(result, session.id);
    } catch (error) {
      return this.terminal(this.fail(input.requestKey, option.alias, error), session.id);
    }
  }

  private async provision(sessionId: string, expected: ExpansionOption, requestKey: string): Promise<ExpansionResult> {
    const { session, option } = await this.finalOption(sessionId, expected);
    let added;
    try {
      added = await this.deps.addRepository({ sessionId: session.id, operationKey: requestKey, repository: { projectId: option.projectId, alias: option.alias, sourcePath: option.sourcePath, baseRef: "HEAD" } }, session.hostId!);
    } catch (error) {
      if (this.isAbort(error)) return this.pending(session.id, option.alias, this.message(error));
      throw error;
    }
    try {
      this.deps.store.appendProvisionedRepository({ sessionId: session.id, requestKey, repository: added.repository, manifestRevision: added.manifestRevision });
      return this.success(session.id, option.alias);
    } catch (recordingError) {
      return this.recoverDiskPresent(session, option, requestKey, recordingError);
    }
  }

  private async replay(expansion: SessionExpansion): Promise<ExpansionResult> {
    if (expansion.outcome !== "pending") return this.resultForReplay(expansion);
    return this.recoverPending(expansion);
  }

  private async recoverDiskPresent(session: SessionSnapshot, option: ExpansionOption, requestKey: string, recordingError: unknown): Promise<ExpansionResult> {
    try {
      const { snapshot, manifest } = await this.readAndReconcile(session);
      if (!this.manifestMatches(manifest, requestKey, option)) throw new Error("The host manifest did not contain the matching provision operation");
      this.deps.store.finishProvisionedExpansion(requestKey);
      return { ...this.success(snapshot.id, option.alias), recovered: true };
    } catch (recoveryError) {
      return this.pending(session.id, option.alias, `Repository ${option.alias} exists on disk pending database recovery: ${this.message(recordingError)}; ${this.message(recoveryError)}`);
    }
  }

  private async recoverPending(expansion: SessionExpansion): Promise<ExpansionResult> {
    const session = this.deps.store.getSession(expansion.sessionId);
    const option = { projectId: expansion.projectId, alias: expansion.alias };
    try {
      const { snapshot, manifest } = await this.readAndReconcile(session);
      if (!this.manifestMatches(manifest, expansion.requestKey, option)) return this.pending(session.id, expansion.alias);
      this.deps.store.finishProvisionedExpansion(expansion.requestKey);
      return this.terminal({ ...this.success(snapshot.id, expansion.alias), recovered: true }, expansion.sessionId);
    } catch (error) {
      return this.pending(session.id, expansion.alias, this.message(error));
    }
  }

  private async readAndReconcile(session: SessionSnapshot): Promise<{ snapshot: SessionSnapshot; manifest: SessionManifest }> {
    if (!session.hostId) throw new Error("Session host is unavailable");
    const manifest = await this.deps.readSession(session.id, session.hostId);
    return { manifest, snapshot: this.deps.store.reconcileRepositories(session.id, manifest.repositories, manifest.revision) };
  }

  private manifestMatches(manifest: SessionManifest, requestKey: string, option: Pick<ExpansionOption, "projectId" | "alias">): boolean {
    return manifest.operations.some((operation) => operation.key === requestKey && operation.projectId === option.projectId && operation.alias === option.alias)
      && manifest.repositories.some((repository) => repository.projectId === option.projectId && repository.alias === option.alias);
  }

  private sessionForThread(threadId: string): SessionSnapshot {
    const session = this.deps.store.getSessionByThreadId(threadId);
    if (!session) throw new Error("This thread is not a workspace session");
    if (session.state !== "active") throw new Error("Only active workspace sessions can add repositories");
    if (!session.hostId) throw new Error("Session host is unavailable");
    return session;
  }

  private async finalOption(sessionId: string, expected: ExpansionOption): Promise<{ session: SessionSnapshot; option: ExpansionOption }> {
    const projects = new Map((await this.deps.listProjects()).map((project) => [project.id, project]));
    const session = this.deps.store.getSession(sessionId);
    if (session.state !== "active") throw new Error("Only active workspace sessions can add repositories");
    if (!session.workspaceId) throw new Error("The saved workspace is unavailable");
    if (!session.hostId) throw new Error("Session host is unavailable");
    let workspace;
    try { workspace = this.deps.store.get(session.workspaceId); } catch { throw new Error("The saved workspace no longer exists"); }
    const member = workspace.repositories.find((repository) => repository.projectId === expected.projectId && repository.alias === expected.alias);
    if (!member) throw new Error(`Repository ${expected.alias} is no longer eligible for this session`);
    if (session.repositories.some((repository) => repository.projectId === expected.projectId || repository.alias === expected.alias)) {
      throw new Error(`Repository ${expected.alias} is no longer eligible for this session`);
    }
    const project = projects.get(expected.projectId);
    if (!project) throw new Error(`Repository ${expected.alias} is no longer eligible for this session`);
    const source = project.sources.find((candidate) => candidate.hostId === session.hostId && candidate.isDefault)
      ?? project.sources.find((candidate) => candidate.hostId === session.hostId);
    if (!source) throw new Error(`Repository ${expected.alias} is no longer eligible for this session`);
    return { session, option: { projectId: project.id, alias: member.alias, projectName: project.name, sourcePath: source.path } };
  }

  private async optionsForSession(session: SessionSnapshot): Promise<ExpansionOption[]> {
    if (session.state !== "active") throw new Error("Only active workspace sessions can add repositories");
    if (!session.workspaceId) throw new Error("The saved workspace is unavailable");
    if (!session.hostId) throw new Error("Session host is unavailable");
    let workspace;
    try { workspace = this.deps.store.get(session.workspaceId); } catch { throw new Error("The saved workspace no longer exists"); }
    const projects = new Map((await this.deps.listProjects()).map((project) => [project.id, project]));
    const presentProjects = new Set(session.repositories.map((repository) => repository.projectId));
    const presentAliases = new Set(session.repositories.map((repository) => repository.alias));
    return workspace.repositories.flatMap((repository) => {
      if (presentProjects.has(repository.projectId) || presentAliases.has(repository.alias)) return [];
      const project = projects.get(repository.projectId);
      if (!project) return [];
      const source = project.sources.find((candidate) => candidate.hostId === session.hostId && candidate.isDefault) ?? project.sources.find((candidate) => candidate.hostId === session.hostId);
      return source ? [{ projectId: project.id, alias: repository.alias, projectName: project.name, sourcePath: source.path }] : [];
    });
  }

  private success(sessionId: string, alias: string): ExpansionResult { return { added: true, alias, policy: this.deps.store.getSession(sessionId).expansionPolicy }; }
  private pending(sessionId: string, alias: string, error?: string): ExpansionResult { return { added: false, alias, policy: this.deps.store.getSession(sessionId).expansionPolicy, pending: true, ...(error ? { error } : {}) }; }
  private cancel(requestKey: string, alias: string): ExpansionResult {
    const expansion = this.deps.store.finishExpansion(requestKey, "cancelled");
    return { added: false, alias, policy: this.deps.store.getSession(expansion.sessionId).expansionPolicy, cancelled: true };
  }
  private fail(requestKey: string, alias: string, error: unknown): ExpansionResult {
    const expansion = this.deps.store.finishExpansion(requestKey, "failed", this.message(error));
    return { added: false, alias, policy: this.deps.store.getSession(expansion.sessionId).expansionPolicy, error: this.message(error) };
  }
  private async terminal(result: ExpansionResult, sessionId: string): Promise<ExpansionResult> {
    try {
      await this.deps.publishChanged();
    } catch (error) {
      try { this.deps.reportError?.({ operation: "workspaces-changed", sessionId, error: this.message(error) }); } catch {}
    }
    return result;
  }
  private resultForReplay(expansion: SessionExpansion): ExpansionResult {
    const policy = this.deps.store.getSession(expansion.sessionId).expansionPolicy;
    if (expansion.outcome === "provisioned") return { added: true, alias: expansion.alias, policy };
    if (expansion.outcome === "cancelled") return { added: false, alias: expansion.alias, policy, cancelled: true };
    return { added: false, alias: expansion.alias, policy, error: expansion.error ?? "Expansion failed" };
  }
  private runOnce(requestKey: string, operation: () => Promise<ExpansionResult>): Promise<ExpansionResult> {
    const existing = this.inFlight.get(requestKey);
    if (existing) return existing;
    const promise = operation();
    this.inFlight.set(requestKey, promise);
    void promise.then(
      () => { if (this.inFlight.get(requestKey) === promise) this.inFlight.delete(requestKey); },
      () => { if (this.inFlight.get(requestKey) === promise) this.inFlight.delete(requestKey); },
    );
    return promise;
  }
  private isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
