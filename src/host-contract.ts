import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_SESSION_REPOSITORIES } from "./contracts";

export const preparedRepositorySchema = z.object({
  projectId: z.string(),
  alias: z.string(),
  sourcePath: z.string(),
  baseRef: z.string(),
  baseCommit: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
}).strict();

const manifestOperationSchema = z.object({
  key: z.string(),
  projectId: z.string(),
  alias: z.string(),
}).strict();

export const sessionManifestSchema = z.object({
  schemaVersion: z.literal(2),
  owner: z.literal("bb-plugin-workspaces"),
  sessionId: z.string(),
  workspaceName: z.string(),
  instructions: z.string(),
  revision: z.number().int().positive(),
  repositories: z.array(preparedRepositorySchema).max(MAX_SESSION_REPOSITORIES),
  operations: z.array(manifestOperationSchema),
}).strict();

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
  ensure_anchor: {
    input: z.object({}).strict(),
    output: z.object({ path: z.string() }).strict(),
  },
  read_session: {
    input: z.object({ sessionId: z.string().regex(/^session_[a-zA-Z0-9-]+$/) }).strict(),
    output: sessionManifestSchema,
  },
  add_repository: {
    input: z.object({
      sessionId: z.string().regex(/^session_[a-zA-Z0-9-]+$/),
      operationKey: z.string().min(8).max(200),
      instructions: z.string(),
      repository: z.object({
        projectId: z.string().min(1),
        alias: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
        sourcePath: z.string().min(1),
        baseRef: z.string().min(1),
      }).strict(),
    }).strict(),
    output: z.object({
      repository: preparedRepositorySchema,
      manifestRevision: z.number().int().positive(),
    }).strict(),
  },
  cleanup_session: {
    input: z.object({
      sessionId: z.string(),
      repositories: z.array(preparedRepositorySchema).min(1).max(MAX_SESSION_REPOSITORIES),
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
