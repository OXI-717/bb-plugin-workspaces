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

export type SessionSnapshot = {
  id: string;
  workspaceId: string | null;
  workspaceName: string;
  workspaceRevision: number;
  instructions: string;
  repositories: SessionRepository[];
  state: "draft" | "preparing" | "active" | "failed" | "archived" | "cleaned";
  hostId: string | null;
  rootPath: string | null;
  primaryProjectId: string | null;
  threadId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
