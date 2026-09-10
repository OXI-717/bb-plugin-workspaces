import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const preparedRepositorySchema = z.object({
  projectId: z.string(),
  alias: z.string(),
  sourcePath: z.string(),
  baseRef: z.string(),
  baseCommit: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
});

export const hostContract = defineRpcContract({
  prepare_session: {
    input: z.object({
      sessionId: z.string(),
      workspaceName: z.string(),
      instructions: z.string(),
      repositories: z.array(z.object({
        projectId: z.string(),
        alias: z.string(),
        sourcePath: z.string(),
        baseRef: z.string(),
      })).min(1).max(20),
    }),
    output: z.object({
      rootPath: z.string(),
      repositories: z.array(preparedRepositorySchema),
    }),
  },
  cleanup_session: {
    input: z.object({
      sessionId: z.string(),
      repositories: z.array(preparedRepositorySchema).min(1).max(20),
    }),
    output: z.object({ cleaned: z.literal(true) }),
  },
  repository_status: {
    input: z.object({ worktreePath: z.string(), baseCommit: z.string() }),
    output: z.object({
      clean: z.boolean(),
      head: z.string(),
      aheadOfBase: z.boolean(),
      changedFiles: z.array(z.object({
        path: z.string(),
        status: z.enum(["added", "modified", "deleted", "renamed", "untracked", "conflicted"]),
      })),
    }),
  },
});
