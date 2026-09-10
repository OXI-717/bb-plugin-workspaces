# Live Workspace Expansion and Multi-Repository Git History

**Status:** Approved design, ready for implementation planning  
**Date:** 2026-09-10  
**Scope:** BB Workspaces plugin, a generic upstream Git History enhancement, and their integration

## Context

The Workspaces plugin can define a group of repositories and start one BB thread with an isolated worktree for each selected repository. The first implementation proved the core workflow, but three product gaps remain:

1. BB displays the hidden real repository used as the thread's owning project in the sidebar.
2. Git History assumes the thread environment root is one Git repository, while a workspace session stores repositories below `repos/<alias>`.
3. An active agent cannot safely add a newly discovered dependency repository to its current session.

This design supersedes the original design wherever the two differ. In particular, a session keeps an immutable initial snapshot but permits append-only expansion, new threads use a neutral synthetic owner instead of a real-repository primary, and the initial task selection follows the current product behavior: select all repositories the first time and remember the user's last subset afterward.

## Goals

- Give new multi-repository threads a neutral sidebar owner named `🧩 Workspaces`.
- Make Git History work with every repository in a workspace session through an explicit repository selector.
- Preserve Git History's existing behavior for normal single-repository threads.
- Let an agent propose adding a repository when it discovers that the current task needs it.
- Require explicit user approval by default, with an option to auto-approve later additions for that session.
- Let the user add a repository manually from the session UI.
- Keep active-session changes append-only and recoverable.
- Preserve existing workspaces, sessions, threads, and repository worktrees.

## Non-goals

- Merging commits from several repositories into one synthetic history.
- Removing or replacing a repository in an active session.
- Letting an agent add an arbitrary local path or clone an arbitrary remote.
- Moving existing threads to the synthetic owner.
- Adding a repository from another host to an active session.
- Automatically deleting the shared synthetic BB project on workspace deletion or plugin uninstall.
- Coupling the Git History plugin to Workspaces-specific files or APIs.

## User experience

### Neutral thread ownership

New workspace threads belong to one plugin-managed BB project named `🧩 Workspaces`. The sidebar therefore shows that name above titles such as `🧩 Workspace · Fix login flow`, instead of showing the first selected repository.

The project is an implementation anchor required by BB, not a "primary" repository. Real repositories remain peers. Existing threads retain their current project ownership.

### Git History repository selector

Git History discovers the Git repositories available in the thread environment:

- If the environment root is a Git worktree, Git History behaves exactly as it does today and shows no selector.
- If the root is not a Git worktree but contains multiple Git worktrees under `repos/*`, Git History shows a repository selector.
- Selecting a repository shows that repository's history, working changes, commit details, patches, and revisions. Histories stay separate and are never interleaved.

The selector appears only when it adds value. A workspace session with one selected repository remains visually equivalent to a normal single-repository thread apart from its path layout.

### Editing a saved workspace

`Edit` changes the saved workspace definition. Membership changes affect which repositories are offered for future tasks and which repositories are eligible for later expansion of active sessions. Editing a workspace does not silently modify its active sessions.

### Adding to an active session

The active session's Repositories panel includes an `Add repository` action. It lists eligible repositories from the current saved workspace that are on the same host and are not already present in the session.

The operation adds a new isolated worktree below the existing session root, updates the session manifest and instructions, and refreshes the UI. Active repositories cannot be removed.

### Agent-proposed expansion

A workspace agent receives a session-specific tool for requesting another repository. It supplies the repository alias and a short reason. Under the default `ask` policy, BB presents a native approval card with three outcomes:

1. **Add this repo** — approve this addition only.
2. **Add and auto-approve more** — approve this addition and set this session's expansion policy to `auto`.
3. **Cancel** — reject without changing the session.

When the policy is `auto`, later valid requests for repositories currently listed in the same saved workspace are provisioned without another prompt. The permission is scoped to one session; it does not change the workspace default or other sessions.

If the workspace has been deleted, or the requested repository is no longer a current member, agent-driven expansion is rejected. The user may first restore membership by editing the workspace.

## Architecture

### 1. Synthetic workspace project

The plugin maintains one stable synthetic BB project named `🧩 Workspaces`.

The host process exposes an operation that ensures a plugin-owned anchor directory exists on a selected host. The server stores the synthetic project ID in plugin storage. Before creating a thread, it:

1. Ensures the synthetic project exists, creating it if necessary.
2. Ensures that project has a source for the selected host, backed by that host's anchor directory.
3. Creates the thread with the synthetic project ID and the explicit unmanaged workspace session root as its environment path.

The anchor directory is not a Git repository and is never presented in the Workspaces repository picker. Project discovery also filters the synthetic project by stored ID and its reserved identity so a repaired installation cannot accidentally offer it as a real repository.

Creation is idempotent. If storage references a missing project, or the project lacks the selected host source, the server repairs the missing object before launching the thread. The synthetic project is shared by all workspaces and sessions; workspace deletion never deletes it.

### 2. Append-only session expansion

The initial session snapshot remains immutable as historical context: workspace identity, task, creation time, original selected repositories, and their base commits do not change. Runtime scope is modeled separately as an append-only repository list plus an expansion journal.

Each session stores:

- `initialRepositories`: the repositories selected at thread creation.
- `repositories`: the current append-only set available to the agent.
- `expansionPolicy`: `ask` or `auto`, defaulting to `ask`.
- `expansions`: repository alias, base commit, branch, path, requester, approval mode, timestamp, and outcome.

Existing session records migrate lazily: their current repositories become both `initialRepositories` and `repositories`, their policy defaults to `ask`, and their expansion journal starts empty.

The plugin store adds lookup by `threadId`, policy updates, and transactional append operations. A unique constraint or equivalent guarded update prevents the same workspace repository from being appended twice.

### 3. Provisioning transaction

The host owns filesystem and Git operations. `add_repository` accepts the session root, a validated repository descriptor, and an idempotency key. It performs these steps:

1. Canonicalize the session root and verify that it is a plugin-owned active session using its manifest.
2. Validate the repository alias and confirm it is not already present.
3. Confirm the source belongs to the selected host and is a valid Git worktree.
4. Resolve and record the base commit.
5. Create a collision-safe session branch and add the worktree at `repos/<alias>` using argument-array Git execution.
6. Atomically replace `session.json` and regenerate `AGENTS.md` with the new repository catalog.
7. Return the repository path, branch, commit, and manifest revision.

If a failure occurs after worktree creation but before the manifest update, the host removes only the just-created worktree and deletes only its just-created branch. A repeated request with the same idempotency key returns the existing result. A repeated request for a repository already in the manifest is also a successful no-op.

The server records the expansion in plugin storage after the host succeeds. If that database write fails, the manifest remains the recovery source: reconciliation imports the manifest entry on the next session read. This ordering ensures the database never advertises a repository that does not exist on disk.

No operation removes a repository from an active session. Normal session cleanup continues to apply to all worktrees listed by the manifest.

### 4. Agent tool and approval state machine

Workspace-origin threads expose a tool such as `workspace_add_repository`. It is not registered for unrelated threads. Its input is:

- `repository`: a workspace repository alias.
- `reason`: a concise explanation shown to the user and stored in the journal.

The server identifies the session from the calling thread ID; callers never provide a session path or workspace ID. It then verifies that:

- the session is active;
- the saved workspace still exists;
- the alias is a current member of that workspace;
- the repository source is on the session host; and
- it is not already in the session.

The state transition is:

```text
active
  -> request validated
      -> ask policy -> pending approval -> approved -> provisioning -> active + repository
                                  |            |             |
                                  |            |             -> failure -> active unchanged
                                  |            -> cancel -> active unchanged
                                  -> add-and-auto -> policy auto -> provisioning
      -> auto policy ---------------------------> provisioning
```

The approval uses `bb.ui.requestInput` with a plugin renderer for the pending interaction, so it appears as a first-class BB approval card rather than an agent-authored chat question. Approval records include the requester, reason, selected action, and time.

The successful tool result returns the new relative and absolute repository paths and tells the agent that the repository is ready. The refreshed `AGENTS.md` also lists it for subsequent turns. Tool registration changes naturally affect newly started provider sessions; the manual UI remains available when an already-running provider has not received the tool definition.

### 5. Manual expansion

The session panel invokes the same validation and provisioning service as the agent tool. It does not bypass membership or host checks. Manual addition records `requester: user` and `approvalMode: manual` and does not automatically change the session policy.

The UI disables an item while it is being provisioned, handles duplicate clicks idempotently, and refreshes both repository and session views from server state after completion.

### 6. Generic Git History extension

The Git History change is developed in a normal fork of its upstream repository, not in BB's installed plugin cache. It remains generic and does not read the Workspaces manifest.

The host adds repository discovery with bounded behavior:

1. If the environment root is a Git worktree, return it as the sole repository.
2. Otherwise inspect only immediate children of `<environment>/repos`.
3. Canonicalize every candidate, ensure it stays inside the environment root, and verify it with Git.
4. Return an opaque relative repository key plus a display label. Never expose an arbitrary-path execution API.

The server adds a `repositories({ threadId })` RPC. Existing history RPCs gain an optional repository key:

- history
- commit details
- commit patch
- working patch
- revision/file history

For every call, the server resolves the thread environment and host, then asks the host to resolve the opaque key within the already discovered set. An absolute path supplied by a client is rejected.

The UI fetches repositories when opening Git History. When there is more than one, it shows a selector and includes the chosen key in every later RPC. Changing the selection clears repository-specific detail state, resets pagination, and prevents stale requests from the previous repository from replacing the new selection's data. With one repository, the selector is hidden and existing layout and interactions remain unchanged.

The fork is installed locally for immediate use while preserving the user's Git History settings. After verification, the branch is pushed to the user's fork and a pull request is opened against the upstream project when GitHub permissions permit. If fork creation or push permission is unavailable, the implementation remains committed locally and the handoff includes a ready-to-open comparison URL or patch; the installed cache is never edited directly.

## Security and trust boundaries

- Agent requests can name only aliases in the current saved workspace.
- Auto-approval applies only to current workspace members on the session's existing host.
- Repository aliases are validated as identifiers and cannot contain separators or traversal segments.
- All candidate paths are canonicalized and checked against their owning root.
- Git commands use structured argument arrays, not interpolated shell commands.
- A client cannot submit an arbitrary absolute path to Workspaces or Git History.
- Cross-host expansion and implicit cloning are rejected.
- The manifest and explicit ownership marker are required before host mutation or cleanup.
- Approval and expansion outcomes are journaled for auditability.

## Failure recovery

- Synthetic project creation and host-source attachment are idempotent and repaired on demand.
- Repository addition is idempotent by operation key and repository membership.
- Worktree creation failures leave database session scope unchanged.
- Post-worktree database failures are reconciled from the atomic manifest.
- A missing or invalid session manifest blocks mutation and reports a recoverable error.
- UI reloads derive state from the server; optimistic selection alone is never treated as completion.
- Git History treats repositories that disappear during a request as unavailable, refreshes discovery, and asks the user to select another repository if necessary.

## Compatibility and migration

- Existing workspace definitions require no destructive migration.
- Existing sessions lazily receive `expansionPolicy: ask`, an initial snapshot derived from their current repositories, and an empty journal.
- Existing threads retain their current real-repository owner and title.
- New threads use `🧩 Workspaces` ownership.
- Git History's single-repository API behavior remains compatible because repository keys are optional when discovery yields one repository.
- Existing plugin settings are retained when switching Git History from the marketplace build to the local fork.

## Testing strategy

### Workspaces unit and integration tests

- Synthetic project ensure/create/repair and per-host source attachment.
- Synthetic project filtering from repository discovery.
- New thread uses synthetic project ID and explicit session environment path.
- Existing session migration defaults.
- Valid agent request under `ask`, each approval outcome, and `auto` follow-up.
- Auto permission does not cross sessions or include removed/non-member repositories.
- Manual addition uses the same validator and does not toggle policy.
- Duplicate and concurrent addition requests are idempotent.
- Rollback after worktree creation failure.
- Manifest-to-database reconciliation after storage failure.
- Regenerated `AGENTS.md` includes the new repository.
- No active-session repository removal path exists.

### Git History tests

- Existing root Git repository retains single-repository behavior.
- A `repos/*` layout discovers all and only immediate valid Git worktrees.
- Non-Git children, symlinks escaping the root, traversal keys, and absolute paths are rejected.
- Repository selection is carried through every history and patch RPC.
- Switching repositories resets details and ignores stale responses.
- A one-repository nested layout hides the selector but targets the nested worktree.

### End-to-end acceptance

Using disposable repositories on one host:

1. Create a workspace and launch a new thread.
2. Confirm the sidebar owner is `🧩 Workspaces` and the task title remains descriptive.
3. Open Git History, switch among all initial repositories, and verify independent histories.
4. Ask the agent to add an eligible repository and choose `Add this repo`.
5. Confirm the worktree, manifest, instructions, session UI, and Git History update.
6. Ask for another repository and choose `Add and auto-approve more`.
7. Confirm a later eligible request proceeds without prompting in that session only.
8. Confirm an ineligible alias and a cross-host source are rejected.
9. Add a repository manually and confirm it follows the same lifecycle.
10. Archive the session and verify cleanup safety across every listed worktree.

## Delivery order

1. Fork Git History, add generic multi-repository discovery and selection with tests, install the local build, and prepare the upstream pull request.
2. Add the synthetic Workspaces project and migrate new thread ownership.
3. Add the append-only session model, host provisioning transaction, and reconciliation.
4. Add the agent tool, native approval renderer, session policy, and manual expansion UI.
5. Run the complete automated suite and disposable-repository end-to-end acceptance flow.
6. Update user documentation to replace the old primary-repository and immutable-session wording.

## Acceptance criteria

The feature is ready when:

- New workspace threads show `🧩 Workspaces` as their owning project.
- Git History can inspect each workspace repository and remains unchanged for ordinary threads.
- An agent can propose a current workspace repository and receives a native approval decision.
- `Add and auto-approve more` is session-scoped and cannot expand beyond current workspace membership.
- The user can add an eligible repository manually.
- Active-session expansion is append-only, idempotent, auditable, and recoverable.
- Existing data and threads continue working without manual migration.
- The generic Git History change is committed in a fork and submitted upstream when permissions allow.

