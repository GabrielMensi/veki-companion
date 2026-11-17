# Veki Companion: orchestration protocol (for agents)

Language: English between agents. The user speaks Spanish; anything addressed to the user is relayed by the root coordinator, never sent by you.

## Roles

- **Root coordinator**: the Claude session the user talks to. It sends tasks to the orchestrator and relays results. It is the only agent that talks to the user.
- **Orchestrator** (Claude Sonnet, medium effort): receives tasks from the root coordinator, spawns exactly one worker per task, reviews the result, reports back. It does not write product code.
- **Workers**: Claude (Sonnet, medium) or Antigravity. One worker per task, in an isolated worktree and branch.

## Git workflow

- Integration branch: `develop`. `main` only receives merges that the user approves through the root coordinator.
- Every worker starts from a fresh `origin/develop`, in its own worktree and branch (`task/<short-name>`). Nobody works in the main tree and nobody shares a working tree.
- A worker opens a PR **to `develop`** only when its work is ready and has been approved by the orchestrator (checks run, evidence reviewed). The PR description states what changed, how it was verified, and any open risk.
- **Merge policy (set by the user on 2026-11-17).** `main` is the deployment branch: only the user approves merges to `main` (through the root coordinator), and nobody merges to `main` without that explicit approval. `develop` is development: the orchestrator may merge a PR into `develop` itself once ALL of these hold: CI is green (or, until CI exists, the evidence commands were re-run by the orchestrator), the diff touches only the files the task allows, no secrets or private data, and the task's "done" evidence is verified. When in doubt, do not merge: report to the root coordinator. Merge in the order the plan prescribes and rebase when needed.
- Always escalate to the root coordinator instead of merging, even into `develop`: anything touching secrets, accounts or tokens, `.github/workflows/render.yml` or other workflows with `workflow_dispatch`, or a change that contradicts `docs/02-diseno.md`.
- Report to the root coordinator a summary per wave: tasks merged, PR links, evidence, open risks.
- **Cleanup is mandatory and tracked by the orchestrator.** After a PR is merged, the orchestrator releases the worker (`worker-release`), removes its worktree, and deletes its local and remote branch. It keeps a list of unmerged PRs and their worktrees, and on every task it also sweeps any merged leftovers. The orchestrator's own worktree stays.
- Branch names created by Orca look like `GabrielMensi/task-<name>`; that is accepted, not an error.
- The repo is public: never use private data in CI, and never put secrets in workflows.
- Commit messages end with the attribution line given by the environment.

## Models

- Default: Claude `claude-sonnet-5-5`, effort medium, for code, diagnosis and design.
- Low tier (reading, triage, docs, mechanical tasks): Claude Haiku or Antigravity Gemini Flash.
- Antigravity is used only when the task says so. Use its Gemini quota by default and ask the root coordinator before using its Claude/GPT quota.
- High and very high tiers (Opus, Fable) need explicit per-task authorization from the user. Recommend with a reason and wait.
- Never switch provider on your own, even out of quota: report and wait.
- After `worker-start`, verify the effective model with `worker-list`. It must match the requested one.

## Antigravity shell rule (copy it into every Antigravity worker spec)

- Run EVERY `orca-ide` command as `timeout 20 orca-ide ... </dev/null 2>&1 | cat ; echo exit=$?`.
- Reports: `timeout 15 orca-ide orchestration send ... ; echo exit=$?`, wait for `lifecycle=completed`, retry once. Never run in the background.

## Orchestration rules

- Pass specs with `--spec "$(cat file)"`, not `--spec-file`.
- Make each spec self-contained: target, change, constraints, files the worker may edit, and the evidence that proves it is done.
- Do not poll `check` or `worker-read` in loops. End your turn and wait for Orca to wake you.
- Verify results yourself (git log, git status, diff, run the checks) before approving. Release workers with `worker-release` when finished.
- If quota runs out, the worker stops and leaves its work in the worktree. Report it to the root coordinator.

## Secrets and private data

- Real secrets live in `.env` in the main tree. It is gitignored and is NOT present in new worktrees. When a task needs it, copy it into the worker's worktree (it stays gitignored). Never print, log, commit or paste key values anywhere.
- `samples/` (voice notes and videos of a real person) is private and gitignored. Copy it into the worktree only when the task needs it. Never commit it, never upload it anywhere except the API the task names, and never include transcripts or content of it in PR descriptions or reports beyond what the task asks for.
- The repo may become public: nothing sensitive may ever be committed.
- Main tree path (WSL): `/home/gabrielmensi/personal-projects/veki-companion`.

## Project context

Read `docs/00-vision-y-decisiones.md` for goals, decisions and open questions. Do not contradict a recorded decision (D1 to D8) without escalating to the root coordinator.

## Reporting

- Worker to orchestrator: `worker_done` with outcome, evidence (commands run and results, PR link) and open blockers.
- Orchestrator to root coordinator: one `worker_done` per task received, summarizing per worker: outcome, evidence, PR link, risks.
