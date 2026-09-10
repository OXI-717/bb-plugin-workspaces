# BB Workspaces

BB Workspaces groups existing BB projects and launches one agent thread across an isolated checkout of each selected repository.

The plugin follows a simple model:

- A **workspace** is a reusable, many-to-many grouping of BB projects. It does not modify or replace those projects.
- A **session** is an immutable snapshot of a workspace revision and repository selection.
- Every selected repository gets its own Git worktree under one session root.
- The thread belongs to a chosen primary BB project, while its unmanaged working directory is the common session root.
- Repository branches survive cleanup. Worktrees are removed only after the session is archived, every working tree is clean, and each checkout is still on its recorded session branch.

## Use it

Open **Workspaces** in BB's navigation, create a workspace, and select the existing BB projects that belong together. To start a task:

1. Choose the repositories needed for this task.
2. Choose a primary repository when more than one is selected.
3. Enter the task prompt and select **Start thread**.

All selected projects must have a source on the same BB host. The new thread starts at a root shaped like:

```text
session root/
  AGENTS.md
  session.json
  repos/
    identity-service/
    api-gateway/
```

The thread's **Repositories** panel reports each checkout independently, including changed files and commits ahead of the session base.

When work is complete, commit or otherwise resolve changes and archive the session. **Remove worktrees** performs a full preflight before deleting anything. Commits remain on the generated branches. If any checkout has uncommitted changes or was switched to another branch, cleanup stops and preserves the whole session for recovery.

## CLI

The CLI is intentionally read-only in the first release:

```bash
bb workspaces list [--json]
bb workspaces show <workspace-id> [--json]
bb workspaces sessions [--json]
```

Workspace creation and session lifecycle operations remain in the UI, where repository and host choices can be reviewed before mutation.

## Development

```bash
npm install
npm test
npm run typecheck
bb plugin build
bb plugin install . --yes
```

The implementation uses only the public BB Plugin SDK and includes a public-SDK boundary test. Host-local Git operations live in `host.ts`; plugin state and orchestration live in `server.ts`; UI surfaces live in `app.tsx`.

## Safety and recovery

- The plugin never changes a BB project's configured source.
- Session directories are plugin-owned and collision checked.
- Worktree paths and manifests are validated before cleanup.
- Cleanup never uses `--force` and never deletes the generated branches.
- Launches have an idempotency key, preventing UI retries from creating duplicate threads.
- If thread creation fails after checkout preparation, the failed session remains visible with its worktrees intact.
