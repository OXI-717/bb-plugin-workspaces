import { z } from "zod";

export const repositoryDraftSchema = z.object({
  projectId: z.string().trim().min(1),
  alias: z.string().trim().regex(/^[a-z][a-z0-9-]{0,47}$/, "Invalid repository alias"),
});

export const workspaceDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2_000),
  instructions: z.string().max(16_000),
  repositories: z.array(repositoryDraftSchema).min(1).max(100),
}).superRefine((value, context) => {
  const aliases = new Set<string>();
  const projects = new Set<string>();
  for (const repository of value.repositories) {
    if (aliases.has(repository.alias)) {
      context.addIssue({ code: "custom", path: ["repositories"], message: `Duplicate repository alias: ${repository.alias}` });
    }
    if (projects.has(repository.projectId)) {
      context.addIssue({ code: "custom", path: ["repositories"], message: `Duplicate project: ${repository.projectId}` });
    }
    aliases.add(repository.alias);
    projects.add(repository.projectId);
  }
});

export type RepositoryDraft = z.infer<typeof repositoryDraftSchema>;
export type WorkspaceDraft = z.infer<typeof workspaceDraftSchema>;

export type WorkspaceRepository = RepositoryDraft & { ordinal: number };

export type Workspace = WorkspaceDraft & {
  id: string;
  revision: number;
  pinned: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  repositories: WorkspaceRepository[];
};

export type SessionRepository = RepositoryDraft & {
  sourceId?: string;
  sourcePath?: string;
  baseRef?: string;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
};

export type ExpansionPolicy = "ask" | "auto";
export type ExpansionRequester = "agent" | "user" | "reconcile";
export type ExpansionApprovalMode = "once" | "auto" | "manual" | "reconciled";
export type ExpansionOutcome = "pending" | "cancelled" | "failed" | "provisioned";

export type SessionExpansion = {
  id: string;
  sessionId: string;
  projectId: string;
  alias: string;
  reason: string;
  requester: ExpansionRequester;
  approvalMode: ExpansionApprovalMode;
  outcome: ExpansionOutcome;
  requestKey: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SessionSnapshot = {
  id: string;
  workspaceId: string | null;
  workspaceName: string;
  workspaceRevision: number;
  instructions: string;
  repositories: SessionRepository[];
  initialRepositories: SessionRepository[];
  expansionPolicy: ExpansionPolicy;
  expansions: SessionExpansion[];
  manifestRevision: number;
  state: "draft" | "preparing" | "active" | "failed" | "archived" | "cleaned";
  hostId: string | null;
  rootPath: string | null;
  ownerProjectId: string | null;
  threadId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
