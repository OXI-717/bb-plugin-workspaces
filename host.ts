import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./src/host-contract";
import {
  addRepository,
  cleanupSession,
  ensureAnchor,
  prepareSession,
  readRepositoryStatus,
  readSessionManifest,
} from "./src/worktrees";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    prepare_session: (input, context) => prepareSession({
      dataRoot: context.experimental_paths.dataDir,
      ...input,
    }),
    ensure_anchor: (_input, context) => ensureAnchor(context.experimental_paths.dataDir),
    read_session: (input, context) => readSessionManifest(context.experimental_paths.dataDir, input.sessionId),
    add_repository: (input, context) => addRepository({
      dataRoot: context.experimental_paths.dataDir,
      ...input,
    }),
    cleanup_session: async (input, context) => {
      await cleanupSession({ dataRoot: context.experimental_paths.dataDir, ...input });
      return { cleaned: true as const };
    },
    repository_status: ({ worktreePath, baseCommit }) =>
      readRepositoryStatus(worktreePath, baseCommit),
  },
});
