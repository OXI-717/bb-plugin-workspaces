# Workspaces Neutral Ownership and Live Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give new multi-repository threads a neutral `🧩 Workspaces` owner and let users or agents append eligible repositories safely to an active session.

**Architecture:** A plugin-owned, host-backed synthetic BB project satisfies BB's thread ownership requirement without making a real repository primary. Session storage separates the immutable initial selection from an append-only current repository set and expansion journal; one shared expansion service validates membership, asks for approval when required, provisions through the host, and reconciles the database from the manifest after partial failures.

**Tech Stack:** TypeScript, React 19, Zod 4, BB Plugin SDK 0.4.47, Node 22 host entry, SQLite through `bb.storage.database()`, Git CLI, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-10-live-expansion-and-multi-repo-history-design.md`

## Global Constraints

- One synthetic project named exactly `🧩 Workspaces` owns all new workspace threads.
- Existing threads and their project ownership remain unchanged.
- Active session repository membership is append-only; no removal operation is introduced.
- Agent expansion defaults to approval and can target only a current member of the saved workspace with a source on the session host.
- `Add and auto-approve more` changes only the current session policy.
- Auto-approval never permits arbitrary paths, cross-host sources, or repositories outside current workspace membership.
- The session manifest is the filesystem recovery source when host provisioning succeeds but database recording fails.
- Git commands use argument arrays; aliases and canonical paths are validated before mutation.
- Preserve all existing workspace/session data and append SQLite migrations instead of editing already-applied migration entries.
- Run shell commands through `rtk`; use `apply_patch` for source and documentation edits.

## File Structure

- `src/contracts.ts` — current/initial session types, expansion policy/journal types, and interaction schemas.
- `src/host-contract.ts` — anchor, session-manifest, and append-repository host RPC schemas.
- `src/store.ts` — append-only migrations, synthetic-project metadata, thread lookup, policy changes, expansion journal, and reconciliation.
- `src/workspace-project.ts` — idempotent synthetic project/source ensure logic behind a small dependency interface.
- `src/workspace-project.test.ts` — create, reuse, repair, source attachment, and collision tests.
- `src/session-expansion.ts` — shared validation, approval, provisioning, recording, and reconciliation service.
- `src/session-expansion.test.ts` — policy state machine, membership/host constraints, idempotency, and recovery tests.
- `src/worktrees.ts` — manifest v2, atomic metadata writes, anchor creation, append worktree transaction, and manifest reading.
- `server.ts` — RPC wiring, thread launch ownership, agent tool/configuration, and realtime publication.
- `host.ts` — host RPC wiring only.
- `app.tsx` — manual addition UI and native approval-card renderer.
- `tests/*.test.ts[x]` — SDK boundary, backend, host, store, and frontend integration tests.
- `README.md`, `skills/workspaces/SKILL.md`, `package.json` — final behavior, agent guidance, and release version.

---

### Task 1: Add the Append-Only Session Data Model

**Files:**
- Modify: `src/contracts.ts`
- Modify: `src/store.ts`
- Modify: `tests/store.test.ts`

**Interfaces:**
- Consumes: existing workspace/session tables and `SessionRepository`.
- Produces: `ExpansionPolicy`, `SessionExpansion`, extended `SessionSnapshot`, metadata accessors, thread lookup, idempotent append/journal methods, and lazy legacy hydration.

- [ ] **Step 1: Write failing migration and session-model tests**

Create a test helper that applies every `WORKSPACE_MIGRATIONS` entry in order before constructing `WorkspaceStore`. Add tests that create an old-schema database using only migration index 0, insert a legacy session, apply later migrations, and assert:

```ts
expect(store.getSession("session_legacy")).toMatchObject({
  initialRepositories: [{ projectId: "proj_auth", alias: "auth" }],
  expansionPolicy: "ask",
  expansions: [],
  manifestRevision: 1,
});
```

Add a new-session test that appends one prepared repository, returns the same session for the same request key, refuses removal/replacement, and finds it with `getSessionByThreadId("thr_1")`.

- [ ] **Step 2: Run store tests and verify failure**

```bash
rtk npm test -- tests/store.test.ts
```

Expected: FAIL because the new fields, migration, and store methods do not exist.

- [ ] **Step 3: Define session and expansion types**

Add these contracts in `src/contracts.ts`:

```ts
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
```

Extend `SessionSnapshot` with `initialRepositories`, `expansionPolicy`, `expansions`, and `manifestRevision`. Rename `primaryProjectId` to nullable `ownerProjectId` in the TypeScript model and database mapping; retain the existing database column for compatibility.

- [ ] **Step 4: Append an immutable migration entry**

Keep `WORKSPACE_MIGRATIONS[0]` byte-for-byte unchanged. Append a second entry that adds nullable `initial_repositories_json`, non-null `expansion_policy DEFAULT 'ask'`, non-null `manifest_revision DEFAULT 1`, a `plugin_metadata` key/value table, and `session_expansions`:

```sql
CREATE TABLE IF NOT EXISTS plugin_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_expansions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  reason TEXT NOT NULL,
  requester TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  outcome TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS session_expansions_provisioned_repo
ON session_expansions(session_id, project_id)
WHERE outcome = 'provisioned';
```

The same migration entry uses `ALTER TABLE sessions ADD COLUMN` for the three new session columns. Do not rerun migrations from the store constructor; production uses `bb.storage.migrate`, and tests use the ordered helper.

```sql
ALTER TABLE sessions ADD COLUMN initial_repositories_json TEXT;
ALTER TABLE sessions ADD COLUMN expansion_policy TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE sessions ADD COLUMN manifest_revision INTEGER NOT NULL DEFAULT 1;
```

- [ ] **Step 5: Implement storage APIs and lazy hydration**

Add exact methods:

```ts
export type BeginExpansionInput = {
  sessionId: string;
  projectId: string;
  alias: string;
  reason: string;
  requester: ExpansionRequester;
  approvalMode: ExpansionApprovalMode;
  requestKey: string;
};

export type AppendProvisionedRepositoryInput = {
  sessionId: string;
  requestKey: string;
  repository: SessionRepository;
  manifestRevision: number;
};

getMetadata(key: string): string | null;
setMetadata(key: string, value: string): void;
getSessionByThreadId(threadId: string): SessionSnapshot | null;
hasSessionForThread(threadId: string): boolean;
setExpansionPolicy(id: string, policy: ExpansionPolicy): SessionSnapshot;
beginExpansion(input: BeginExpansionInput): SessionExpansion;
finishExpansion(requestKey: string, outcome: "cancelled" | "failed", error?: string): SessionExpansion;
appendProvisionedRepository(input: AppendProvisionedRepositoryInput): SessionSnapshot;
reconcileRepositories(sessionId: string, repositories: SessionRepository[], manifestRevision: number): SessionSnapshot;
```

`appendProvisionedRepository` runs one SQLite transaction: load current JSON, no-op if the project already exists, append the repository, advance `manifest_revision`, mark the journal row `provisioned`, and update timestamps. `hydrateSession` uses `repositories_json` when `initial_repositories_json` is null and defaults missing policy/revision fields.

- [ ] **Step 6: Run store tests**

```bash
rtk npm test -- tests/store.test.ts
rtk npm run typecheck
```

Expected: PASS for legacy hydration, new snapshots, policy persistence, thread lookup, request-key idempotency, append-only membership, and manifest reconciliation.

- [ ] **Step 7: Commit the data model**

```bash
rtk git add src/contracts.ts src/store.ts tests/store.test.ts
rtk git commit -m "feat: model append-only workspace expansion"
```

### Task 2: Add Host Anchor and Repository Provisioning Transactions

**Files:**
- Modify: `src/host-contract.ts`
- Modify: `src/worktrees.ts`
- Modify: `host.ts`
- Modify: `tests/worktrees.test.ts`

**Interfaces:**
- Consumes: current session layout and `PreparedRepository`.
- Produces: `ensureAnchor`, `readSessionManifest`, `addRepository`, manifest schema v2, and host handlers `ensure_anchor`, `read_session`, `add_repository`.

- [ ] **Step 1: Write failing worktree tests**

Add tests for:

```ts
const anchor = await ensureAnchor(dataRoot);
expect(anchor.path).toBe(join(dataRoot, "workspace-anchor"));
expect(JSON.parse(readFileSync(join(anchor.path, ".bb-workspaces-anchor.json"), "utf8")))
  .toEqual({ schemaVersion: 1, owner: "bb-plugin-workspaces" });

const added = await addRepository({
  dataRoot,
  sessionId: "session_expand",
  operationKey: "expand-audits-1",
  repository: {
    projectId: "proj_audits",
    alias: "audits",
    sourcePath: audits.path,
    baseRef: "HEAD",
  },
});
expect(readSessionManifest(dataRoot, "session_expand").repositories.at(-1))
  .toMatchObject({ alias: "audits", worktreePath: added.repository.worktreePath });
```

Also test duplicate operation keys, duplicate repositories under a new key, invalid aliases, a mismatched/missing ownership marker, atomic manifest replacement, and rollback of the new worktree/branch when metadata writing fails through an injected file-operation seam.

Add a concurrent test that calls `addRepository` twice for the same session/project with different operation keys and asserts one worktree, one branch, and one manifest entry result.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
rtk npm test -- tests/worktrees.test.ts
```

Expected: FAIL because anchor/manifest/addition APIs are not implemented.

- [ ] **Step 3: Define manifest v2 and atomic file helpers**

In `src/worktrees.ts`, define:

```ts
export type SessionManifest = {
  schemaVersion: 2;
  owner: "bb-plugin-workspaces";
  sessionId: string;
  workspaceName: string;
  instructions: string;
  revision: number;
  repositories: PreparedRepository[];
  operations: Array<{ key: string; projectId: string; alias: string }>;
};
```

`readSessionManifest(dataRoot, sessionId)` resolves only `<dataRoot>/sessions/<safe-session-id>/session.json`, validates the owner/session ID/repository paths, and upgrades schema v1 in memory with revision 1 and an empty operations array. Add `writeAtomic(path, contents)` that writes a same-directory uniquely named temporary file with mode `0o600`, then renames it over the target and unlinks the temporary file on failure.

- [ ] **Step 4: Implement a stable host anchor**

`ensureAnchor(dataRoot)` creates `<dataRoot>/workspace-anchor`, writes `.bb-workspaces-anchor.json` create-only when absent, validates an existing marker, and returns `{ path }`. It never initializes Git and never deletes the directory.

- [ ] **Step 5: Upgrade initial session preparation**

Write schema v2 from `prepareSession`, including the ownership marker, instructions, revision 1, and empty operation list. Generate `AGENTS.md` from the prepared repository set so exact resolved repository metadata is available for later rewrites.

- [ ] **Step 6: Implement idempotent append provisioning**

Add:

```ts
export async function addRepository(input: {
  dataRoot: string;
  sessionId: string;
  operationKey: string;
  repository: PrepareRepository;
}): Promise<{ repository: PreparedRepository; manifestRevision: number }>;
```

Validate the manifest before Git mutation. Return an existing repository when either the operation key or project ID already appears. Otherwise resolve the base commit, create `bb-workspace/<session-slug>/<alias>`, add the worktree at `repos/<alias>`, write new `AGENTS.md`, then atomically publish the new manifest revision. If publishing fails, restore the prior instructions file, remove only the new worktree, and delete only the branch created by this call.

Serialize additions per session with a module-local promise queue that deletes its map entry in `finally`. Different sessions may provision concurrently; calls for the same session must re-read the manifest after acquiring the queue so duplicate requests become successful no-ops.

- [ ] **Step 7: Extend and wire the host contract**

Add Zod-validated methods:

```ts
ensure_anchor: {
  input: z.object({}).strict(),
  output: z.object({ path: z.string() }).strict(),
}
read_session: {
  input: z.object({ sessionId: z.string().regex(/^session_[a-zA-Z0-9-]+$/) }).strict(),
  output: sessionManifestSchema,
}
add_repository: {
  input: z.object({
    sessionId: z.string().regex(/^session_[a-zA-Z0-9-]+$/),
    operationKey: z.string().min(8).max(200),
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
}
```

Keep `dataRoot` host-owned through `context.experimental_paths.dataDir`; never accept it from the server or UI.

- [ ] **Step 8: Run host-focused and compatibility tests**

```bash
rtk npm test -- tests/worktrees.test.ts
rtk npm run typecheck
```

Expected: PASS for initial preparation, v1 read compatibility, v2 manifests, append success/idempotency/rollback, status, and cleanup across appended repositories.

- [ ] **Step 9: Commit host provisioning**

```bash
rtk git add src/host-contract.ts src/worktrees.ts host.ts tests/worktrees.test.ts
rtk git commit -m "feat: provision repositories into active sessions"
```

### Task 3: Introduce the Synthetic `🧩 Workspaces` Project

**Files:**
- Create: `src/workspace-project.ts`
- Create: `tests/workspace-project.test.ts`
- Modify: `src/store.ts`
- Modify: `server.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- Consumes: `ensure_anchor` host RPC, `WorkspaceStore` metadata, and BB `projects.create`, `projects.get`, `projects.list`, and `projects.sources.add`.
- Produces: `ensureWorkspaceProject(deps, hostId): Promise<string>` returning the stable synthetic project ID.

- [ ] **Step 1: Write failing project lifecycle tests**

Test these cases through a dependency-fake unit test:

```ts
expect(await ensureWorkspaceProject(deps, "host_local")).toBe("proj_workspaces");
expect(calls.create).toEqual([{
  name: "🧩 Workspaces",
  source: { type: "local_path", hostId: "host_local", path: "/plugin/anchor" },
}]);
```

Then call again and assert no duplicate project. Add cases for stored ID pointing to a deleted project, an existing anchor project missing the requested host source, and an unrelated user project with the same display name but a different path.

Run two ensures concurrently in the unit test and assert only one create/source mutation. The implementation keeps one in-flight ensure promise per host and clears it in `finally`.

In `tests/server.test.ts`, change launch expectations so `threads.spawn.projectId` is `proj_workspaces`, while `environment.workspace.path` remains the common session root. Assert the synthetic project is absent from `dashboard.projects`.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
rtk npm test -- tests/workspace-project.test.ts tests/server.test.ts
```

Expected: FAIL because launch still assigns the first selected repository.

- [ ] **Step 3: Implement the idempotent ensure service**

Define a dependency interface in `src/workspace-project.ts` rather than importing the plugin singleton:

```ts
export type WorkspaceProjectDeps = {
  getStoredProjectId(): string | null;
  setStoredProjectId(id: string): void;
  ensureAnchor(hostId: string): Promise<{ path: string }>;
  getProject(id: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  addSource(projectId: string, input: LocalPathSourceInput): Promise<void>;
};

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
```

Resolution order is: valid stored project; project whose source on the requested host exactly matches the returned anchor path; otherwise create. Attach a missing host source to the resolved project and persist its ID. Do not adopt by display name alone.

- [ ] **Step 4: Wire BB SDK operations and launch ownership**

In `server.ts`, adapt the dependency methods to:

```ts
bb.sdk.projects.create({
  name: "🧩 Workspaces",
  source: { type: "local_path", hostId, path: anchor.path },
});
bb.sdk.projects.sources.add({
  projectId,
  type: "local_path",
  hostId,
  path: anchor.path,
});
```

Call `ensureWorkspaceProject` after repository/host validation but before `prepare_session`, so project failure cannot leave prepared worktrees behind. Persist it as `ownerProjectId` and pass it to `threads.spawn`. Filter that stored project ID from repository listings and reject it in workspace create/update validation. Existing sessions keep their stored owner and threads are not updated.

Update the public `sessionSchema` at the same time so it returns `ownerProjectId`, `initialRepositories`, `expansionPolicy`, `expansions`, and `manifestRevision`; remove the stale `primaryProjectId` response field.

- [ ] **Step 5: Run project/server tests**

```bash
rtk npm test -- tests/workspace-project.test.ts tests/server.test.ts tests/store.test.ts
rtk npm run typecheck
```

Expected: PASS for create/reuse/repair/source attachment, neutral thread ownership, real-repository peer selection, and launch idempotency.

- [ ] **Step 6: Commit neutral ownership**

```bash
rtk git add src/workspace-project.ts tests/workspace-project.test.ts src/store.ts server.ts tests/server.test.ts
rtk git commit -m "feat: own workspace threads with neutral project"
```

### Task 4: Build the Shared Expansion Service

**Files:**
- Create: `src/session-expansion.ts`
- Create: `tests/session-expansion.test.ts`
- Modify: `src/contracts.ts`
- Modify: `src/store.ts`

**Interfaces:**
- Consumes: Task 1 store APIs and Task 2 host APIs.
- Produces: `SessionExpansionService.optionsForThread`, `.requestFromAgent`, `.addManually`, `.reconcileSession`, and `.reconcileActiveSessions`.

- [ ] **Step 1: Write failing policy and recovery tests**

Use in-memory store data and fake dependencies. Cover:

- `ask` calls approval and handles `add-once`, `add-and-auto`, and `cancel`.
- `auto` skips approval only for a current workspace member.
- deleted workspace, removed member, same project already present, inactive session, missing same-host source, and cross-host-only source are rejected before host mutation.
- manual addition records `requester: user`, `approvalMode: manual`, and leaves policy unchanged.
- host failure records `failed` and leaves repository JSON unchanged.
- database append failure after host success is repaired by `reconcileSession` from `read_session`.
- repeated `requestKey` returns the prior result without another host call.

Representative assertion:

```ts
expect(await service.requestFromAgent({
  threadId: "thr_1",
  alias: "audits",
  reason: "The gateway imports the audit contract.",
  requestKey: "tool-call-1",
  signal,
})).toMatchObject({ added: true, alias: "audits", policy: "auto" });
expect(deps.approvals).toHaveLength(1);
expect(deps.hostAdds).toHaveLength(1);
```

- [ ] **Step 2: Run focused tests and verify failure**

```bash
rtk npm test -- tests/session-expansion.test.ts
```

Expected: FAIL because the expansion service does not exist.

- [ ] **Step 3: Define approval payload/response schemas**

In `src/contracts.ts`, add strict schemas:

```ts
export const expansionApprovalPayloadSchema = z.object({
  sessionId: z.string(),
  workspaceName: z.string(),
  repositoryAlias: z.string(),
  repositoryName: z.string(),
  reason: z.string().min(1).max(2_000),
}).strict();

export const expansionApprovalResponseSchema = z.object({
  action: z.enum(["add-once", "add-and-auto", "cancel"]),
}).strict();
```

Add `ExpansionOption` with `projectId`, `alias`, `projectName`, and `sourcePath` returned only from the trusted server service, not accepted from clients.

- [ ] **Step 4: Implement validation and resolution**

Construct the service with narrow async dependencies for project listing, host calls, approval, and realtime notification. `optionsForThread(threadId)` looks up the active session, requires the saved workspace, intersects current workspace members with current BB projects, excludes session members, and keeps only sources on `session.hostId`.

`requestFromAgent` accepts an alias, resolves it through those options, begins the journal entry, requests approval only under `ask`, validates the response schema, and calls one private `provision()` method. `addManually` accepts `projectId` plus request key, resolves it through the same options, and calls the same `provision()` method.

- [ ] **Step 5: Implement provision-and-reconcile ordering**

`provision()` calls host `add_repository` first. It then calls `appendProvisionedRepository`. On database failure it immediately calls `read_session` and `reconcileRepositories`; only if both recording and reconciliation fail does it return an error that names the repository as present on disk but pending database recovery. `reconcileSession(sessionId)` exposes the same manifest-to-database repair for normal read paths, and `reconcileActiveSessions()` runs it for active sessions without changing archived or cleaned rows.

For `add-and-auto`, persist `expansionPolicy: auto` after the approval decision and before host provisioning, matching the approved state machine. Cancellation records `cancelled` without host calls. Every terminal result publishes `workspaces-changed`.

- [ ] **Step 6: Run service and store tests**

```bash
rtk npm test -- tests/session-expansion.test.ts tests/store.test.ts
rtk npm run typecheck
```

Expected: PASS for every decision path, scope check, failure, retry, and recovery case.

- [ ] **Step 7: Commit the expansion service**

```bash
rtk git add src/session-expansion.ts tests/session-expansion.test.ts src/contracts.ts src/store.ts
rtk git commit -m "feat: orchestrate live session expansion"
```

### Task 5: Expose Manual and Agent Expansion Through the Server

**Files:**
- Modify: `server.ts`
- Modify: `tests/server.test.ts`
- Modify: `skills/workspaces/SKILL.md`

**Interfaces:**
- Consumes: Task 4 `SessionExpansionService`.
- Produces: `session_expansion_options` and `session_add_repository` RPCs, native tool `workspace_add_repository`, and conditional agent configuration.

- [ ] **Step 1: Write failing server/tool tests**

Add SDK harness tests that assert:

```ts
expect(harness.registrations.agentTools.some((tool) =>
  tool.name === "workspace_add_repository"
)).toBe(true);

const configuration = await harness.behavior.resolveAgentConfiguration(
  makePluginAgentConfigurationContext({
    thread: { id: "thr_workspace" },
    project: { id: "proj_workspaces", name: "🧩 Workspaces" },
    origin: { kind: null, pluginId: "workspaces" },
  }),
);
expect(configuration.tools).toContain("workspace_add_repository");
```

Assert an unrelated thread receives no tool or workspace skill. Start `callAgentTool` without awaiting it, inspect `harness.inspection.pendingInteractions[0]`, submit each response through `harness.behavior.submitInteraction(interaction.id, value)`, and assert the host receives only alias-resolved project/source data. Test the manual RPC separately.

- [ ] **Step 2: Run server tests and verify failure**

```bash
rtk npm test -- tests/server.test.ts
```

Expected: FAIL because neither RPC nor agent surface is registered.

- [ ] **Step 3: Add repository expansion RPCs**

Extend `rpcContract` with:

```ts
const expansionResultSchema = z.object({
  added: z.boolean(),
  alias: z.string(),
  worktreePath: z.string().nullable(),
  policy: z.enum(["ask", "auto"]),
  session: sessionSchema,
}).strict();

session_expansion_options: {
  input: z.object({ threadId: z.string() }),
  output: z.object({ session: sessionSchema, repositories: z.array(expansionOptionSchema) }),
},
session_add_repository: {
  input: z.object({
    threadId: z.string(),
    projectId: z.string(),
    requestKey: z.string().min(8).max(200),
  }),
  output: expansionResultSchema,
},
```

The options RPC reconciles the target session manifest before returning. The dashboard RPC and `bb workspaces sessions` CLI path call `reconcileActiveSessions()` before listing, satisfying the next-read recovery rule. Reconciliation errors are logged and surfaced on the affected session without hiding other sessions. The add RPC passes `reason: "Added from the Repositories panel"` to `addManually`.

- [ ] **Step 4: Register the native tool and approval request**

Register:

```ts
import { randomUUID } from "node:crypto";

bb.agents.registerTool({
  name: "workspace_add_repository",
  description: "Request another repository from this thread's saved multi-repository workspace.",
  instructions: "Use only when the task requires a workspace repository that is not already in session.json. Explain the concrete dependency in reason.",
  presentation: {
    label: { pending: "Requesting workspace repository", completed: "Requested workspace repository" },
    suppress: true,
  },
  parameters: z.object({
    repository: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    reason: z.string().trim().min(1).max(2_000),
  }).strict(),
  async execute({ repository, reason }, { threadId, signal }) {
    const result = await expansion.requestFromAgent({
      threadId,
      alias: repository,
      reason,
      requestKey: `agent-${randomUUID()}`,
      signal,
    });
    return result.added
      ? `Repository ${result.alias} is ready at ${result.worktreePath}. Re-read session.json and continue there.`
      : `Repository request was cancelled; the session was not changed.`;
  },
});
```

The service's approval adapter calls `bb.ui.requestInput` with renderer ID `workspace-add-repository`, the typed payload, and the tool signal. Parse all submitted values with `expansionApprovalResponseSchema`.

- [ ] **Step 5: Configure the tool only for workspace sessions**

Register one synchronous `bb.agents.configure` callback. Require `context.origin.pluginId === "workspaces"` and `store.hasSessionForThread(context.thread.id)`. Return:

```ts
{
  tools: ["workspace_add_repository"],
  skills: ["multi-repo-workspaces"],
  instructions: "This is an append-only Workspaces session. If a current workspace member is required but absent from session.json, request it with workspace_add_repository.",
}
```

Return empty arrays for unrelated and side-chat threads. Do not perform async SDK calls inside `configure`.

- [ ] **Step 6: Update the workspace skill**

Keep the rule against editing `session.json` manually. Add that the agent may use `workspace_add_repository` for a concrete missing dependency, must include a reason, and may proceed only after the tool reports the worktree ready.

- [ ] **Step 7: Run backend, configuration, and SDK boundary tests**

```bash
rtk npm test -- tests/server.test.ts tests/session-expansion.test.ts tests/sdk-boundary.test.ts
rtk npm run typecheck
```

Expected: PASS for conditional tool selection, native approval interactions, auto policy, manual RPC, and unrelated-thread isolation.

- [ ] **Step 8: Commit server surfaces**

```bash
rtk git add server.ts tests/server.test.ts skills/workspaces/SKILL.md
rtk git commit -m "feat: let agents request workspace repositories"
```

### Task 6: Add the Approval Card and Manual Repository UI

**Files:**
- Modify: `app.tsx`
- Modify: `tests/app.test.tsx`

**Interfaces:**
- Consumes: Task 5 RPCs and `expansionApprovalPayloadSchema`/`expansionApprovalResponseSchema`.
- Produces: pending-interaction renderer `workspace-add-repository` and manual `Add repository` workflow in the Repositories panel.

- [ ] **Step 1: Write failing approval-card tests**

Render the pending interaction slot with a valid payload and `submit` callback that pushes values into a local `submissions` array. Click each button and assert:

```ts
expect(submissions).toContainEqual({
  action: "add-and-auto",
});
```

Assert the card displays workspace, alias, and agent reason. With an invalid payload, assert it renders an error and only cancellation is available.

- [ ] **Step 2: Write failing manual-add panel tests**

Render the Repositories action for an active session. Mock `session_expansion_options` with one eligible repository, click `Add repository`, select the repository, and submit. Assert `session_add_repository` receives the current `threadId`, trusted project ID from the option, and a stable request key. Assert success reloads repository state and duplicate clicks stay disabled while pending.

- [ ] **Step 3: Run frontend tests and verify failure**

```bash
rtk npm test -- tests/app.test.tsx
```

Expected: FAIL because the renderer and manual control are absent.

- [ ] **Step 4: Implement the approval renderer**

Add a component accepting `PluginPendingInteractionProps`. Parse `interaction.payload` with `expansionApprovalPayloadSchema`, reset busy/error state on interaction ID change, and render three actions:

```tsx
<Button onClick={() => submit({ action: "add-once" })}>Add this repo</Button>
<Button onClick={() => submit({ action: "add-and-auto" })}>Add and auto-approve more</Button>
<Button variant="ghost" onClick={() => submit({ action: "cancel" })}>Cancel</Button>
```

Register it with `app.slots.pendingInteraction({ id: "workspace-add-repository", component: WorkspaceRepositoryApproval })`. Keep payload data untrusted until parsed.

- [ ] **Step 5: Implement manual addition in `RepositoriesPanel`**

Load `session_expansion_options({ threadId })` when the panel mounts and after `workspaces-changed`. If options exist and the session is active, show `Add repository`; reveal a native select and confirmation button. Generate one request key when the form opens, reuse it across retries, and replace it only after success. On success reload the dashboard/options and show the appended repository card.

If no eligible repositories remain, show `All current workspace repositories are already available.` Do not show removal controls. Explain that editing the workspace changes future eligibility but does not silently mutate this session.

- [ ] **Step 6: Run frontend and complete unit tests**

```bash
rtk npm test -- tests/app.test.tsx
rtk npm test
rtk npm run typecheck
```

Expected: PASS for approval choices, invalid payload safety, manual addition, pending-state idempotency, remembered launch selection, and the existing workspace modal.

- [ ] **Step 7: Commit the user experience**

```bash
rtk git add app.tsx tests/app.test.tsx
rtk git commit -m "feat: approve and add session repositories"
```

### Task 7: Update Documentation and Release Metadata

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Verify: `docs/superpowers/specs/2026-09-10-live-expansion-and-multi-repo-history-design.md`

**Interfaces:**
- Consumes: completed ownership and expansion behavior.
- Produces: accurate user-facing documentation and plugin version `0.2.0`.

- [ ] **Step 1: Replace stale product wording**

Update README to say:

- the initial session selection is immutable historical context while active scope can expand append-only;
- `🧩 Workspaces` is the neutral owner for new threads and no real repository is primary;
- Edit changes the saved workspace and manual Add changes one active session;
- agent requests default to approval, and auto-approval is session-only/current-members-only;
- Git History works through the generic companion plugin enhancement;
- cleanup remains all-or-nothing for clean worktrees and preserves committed branches.

- [ ] **Step 2: Bump the feature release version**

Change both package files from `0.1.1` to `0.2.0`. Do not change `engines.bb` or `engines.bbPluginSdk` unless `rtk bb plugin types --check` reports a required version change.

- [ ] **Step 3: Run documentation and manifest checks**

```bash
rtk rg -n "primary|immutable|auto-approve|🧩 Workspaces|Add repository" README.md skills/workspaces/SKILL.md
rtk bb plugin types --check
rtk git diff --check
```

Expected: no stale claim that a real repository is primary or that active scope cannot expand; new safety boundaries are explicit.

- [ ] **Step 4: Commit documentation**

```bash
rtk git add README.md package.json package-lock.json
rtk git commit -m "docs: explain live workspace expansion"
```

### Task 8: Verify, Install, and Run End-to-End Acceptance

**Files:**
- Verify generated: `dist/server.js`, `dist/host.js`, `dist/app.js`, `dist/app.css`
- Verify live data: existing Workspaces database and session roots without mutation beyond the explicit disposable test session.

**Interfaces:**
- Consumes: all previous Workspaces tasks and the locally installed Git History result from its separate plan.
- Produces: running Workspaces 0.2.0 with evidence for compatibility and the approved end-to-end flows.

- [ ] **Step 1: Run the complete immutable verification suite**

```bash
rtk bb plugin types --check
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk git diff --check
rtk git status --short --branch
```

Expected: every test passes, typecheck/build succeed, and the branch is clean.

- [ ] **Step 2: Capture existing live state before reload**

```bash
rtk bb workspaces list --json
rtk bb workspaces sessions --json
rtk bb plugin list --json
```

Record workspace IDs, session IDs/states, plugin source/version, and Git History settings. Do not archive, clean, or alter existing user sessions.

- [ ] **Step 3: Reload the path-installed Workspaces plugin**

```bash
rtk bb plugin reload workspaces
rtk bb plugin list --json
rtk bb workspaces list --json
rtk bb workspaces sessions --json
```

Expected: Workspaces is running at 0.2.0, existing definitions and sessions remain, and legacy rows hydrate with `ask` policy without changing existing thread ownership.

- [ ] **Step 4: Run disposable-repository end-to-end acceptance**

Create three small temporary Git repositories as ordinary BB projects on one host, create a disposable workspace, and verify:

1. A new thread's sidebar owner is `🧩 Workspaces` and its title remains descriptive.
2. Git History switches among the initial repository worktrees.
3. An agent request produces the native three-choice approval card.
4. `Add this repo` appends one worktree and updates the manifest, instructions, panel, and Git History.
5. `Add and auto-approve more` sets only that session to `auto`; a later eligible addition skips prompting.
6. An alias outside current workspace membership and a cross-host-only source are rejected.
7. Manual Add uses the same worktree lifecycle.
8. Archiving then cleaning a clean disposable session removes its worktrees and preserves all generated branches.

- [ ] **Step 5: Verify existing user state again**

```bash
rtk bb workspaces list --json
rtk bb workspaces sessions --json
rtk bb plugin list --json
```

Expected: pre-existing workspace/session IDs and states still match the capture from Step 2, apart from normal `updatedAt` values caused by reads/reconciliation. Existing threads still show their old owner; only newly launched threads use the synthetic project.

- [ ] **Step 6: Record final evidence**

Add no generated build output to Git unless it was already tracked by the repository. Report exact test counts, build result, installed plugin versions/sources, disposable session ID, Git History PR URL, and any user-visible limitation that remains (especially the need to restart/resume a provider session created before tool registration).
