/**
 * The one orch-lite work-area tool: `orch_tool`.
 *
 * Three operations, one schema — the tool is registered by the HOST row, so it
 * is visible in **every** session of every preset, and one schema is the whole
 * cost that visibility adds to each request. Sessions bound to the `orch-lite`
 * preset additionally get the protocol section, the worker hint and the gate;
 * elsewhere the tool works exactly the same, but nothing enforces the
 * discipline around it (load the skill `orch-lite` first).
 *
 * Package: dsh-orch-lite. Decision history: see DEVLOG.md.
 */

import { join } from 'node:path'
import { defineTool } from './define-tool.js'
import {
	assertSlug,
	ensureGitignore,
	repositoryFor,
	SLOW_GIT_TIMEOUT_MS,
	WORKTREES_DIR,
} from './workspace.js'
import {
	dirtyFiles,
	hasBranch,
	listWorktrees,
	normalizeGitPath,
	unmergedFiles,
} from './git.js'

/** The model-facing tool name. snake_case on purpose: a hyphenated name is an
 * "exotic" identifier that PTC-mode SDK bindings must reach through bracket
 * access, and this profile can run PTC. */
export const ORCH_TOOL = 'orch_tool'

/** Actions the tool accepts. */
export const ORCH_ACTIONS = ['create', 'merge', 'remove']

const DESCRIPTION =
	'orch-lite work areas — one call for the three work-area operations. ' +
	'action:"create" allocates .worktrees/<feature_id>/ on branch feature/<feature_id>: call it before dispatching any write task (every feature agent owns exactly one area; read-only sweeps never get one), it is idempotent and re-claims a handed-off area, and in a folder with no git repository it establishes the minimum one and reports that in the result. ' +
	'action:"merge" merges feature/<feature_id> into the currently checked-out branch of the primary tree — confirm that branch with a read-only git status, and pass into:"<target>" when it is not where the work belongs; on conflict the merge aborts, is rolled back and returns the conflicted file list for a human decision — never auto-resolve. ' +
	'action:"remove" retires the area after the feature agent reported DONE and committed; a dirty area is refused and the branch is always kept. ' +
	'feature_id must be verbatim identical to the owning subagent description and the package feature_id. ' +
	'In a session outside the orch-lite preset this tool still works, but nothing enforces the discipline — load the skill orch-lite first and follow it.'

/**
 * Register `orch_tool`. Called by the host half only; the preset half registers
 * no tools at all.
 *
 * @param {object} ctx
 */
export function registerOrchTool(ctx) {
	ctx.tools.register(
		defineTool({
			name: ORCH_TOOL,
			description: DESCRIPTION,
			parameters: {
				action: {
					type: 'string',
					required: true,
					enum: ORCH_ACTIONS,
					description: 'Operation: create a write area, merge its branch, or remove the write area.',
				},
				feature_id: {
					type: 'string',
					required: true,
					description:
						'Feature id, lowercase kebab-case; verbatim identical to the owning agent description, the package feature_id and the branch name.',
				},
				base: {
					type: 'string',
					description: 'create only: base ref for a new branch, defaults to current HEAD. Ignored when the branch exists.',
				},
				into: {
					type: 'string',
					description:
						'merge only: branch to merge into. Defaults to the currently checked-out branch. ' +
						'Required when the primary tree is itself on feature/<feature_id> — pass the branch the work should land on.',
				},
			},
			output: {
				schema: { type: 'json' },
				render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
			},
			async execute(args, exec) {
				assertSlug(args.feature_id, 'feature_id')
				switch (args.action) {
					case 'create':
						return createArea(ctx, args, exec)
					case 'merge':
						return mergeBranch(ctx, args, exec)
					case 'remove':
						return removeArea(ctx, args, exec)
					default:
						// Unreachable through the enum, kept for direct callers.
						throw new Error(`unsupported action ${JSON.stringify(args.action)}; expected one of ${ORCH_ACTIONS.join(', ')}.`)
				}
			},
		}),
	)
}

/**
 * One human line per operation for the model.
 *
 * @param {object} value the tool's JSON result
 * @returns {string}
 */
function renderResult(value) {
	if (value.action === 'create') {
		const verb = value.reused ? 'reusing write area' : 'created write area'
		return (
			`${verb} for feature ${value.feature_id}: ${value.worktree_path} (branch ${value.branch}).\n` +
			(value.note ? `${value.note}\n` : '') +
			`Dispatch or resume with subagent({ description: "${value.feature_id}" }) and set the package "worktree" to this path.`
		)
	}
	if (value.action === 'merge') {
		if (value.conflict) {
			return (
				`CONFLICT feature_id=${value.feature_id} files=${JSON.stringify(value.files)}: needs a human decision. ` +
				`Rolled back; the working tree stays on ${value.into} and is otherwise untouched.` +
				(value.reason === '' ? '' : ` git: ${value.reason}`)
			)
		}
		return `Merged ${value.branch} into ${value.into} (${value.files.length} files): ${value.files.join(', ')}`
	}
	if (value.skipped === true) {
		return (
			`No work area for feature ${value.feature_id}: nothing to remove (it was never created, or already retired). ` +
			'Its branch (if any) is untouched.'
		)
	}
	if (!value.removed) {
		return (
			`Work area is dirty (uncommitted changes): ${value.dirty.join(', ')}; kept ${value.worktree_path}, branch ${value.branch ?? '(detached)'} untouched. ` +
			'Have the agent commit first, or leave the decision to the user.'
		)
	}
	return `Removed ${value.worktree_path}; branch ${value.branch ?? '(detached)'} kept.`
}

/**
 * action "create": allocate (or re-claim) the feature's write area.
 *
 * @param {object} ctx
 * @param {object} args
 * @param {object} exec
 */
async function createArea(ctx, args, exec) {
	// The only call site allowed to bootstrap a missing repository.
	const { git, root, bootstrapped } = await repositoryFor(ctx, exec, { create: true })
	const branch = `feature/${args.feature_id}`
	const path = normalizeGitPath(join(root, WORKTREES_DIR, args.feature_id))
	const worktrees = await listWorktrees(git, root, exec.signal)

	const existing = worktrees.find(entry => entry.path === path)
	if (existing !== undefined) {
		return {
			ok: true,
			action: 'create',
			feature_id: args.feature_id,
			worktree_path: existing.path,
			branch: existing.branch ?? branch,
			created: false,
			reused: true,
			note: bootstrapped,
		}
	}

	// Git allows one worktree per branch: if the branch lives elsewhere
	// (legacy layout, manual checkout), hand that path back rather than
	// failing — it still IS this feature's write area. See DEVLOG.md.
	const branchHolder = worktrees.find(entry => entry.branch === branch)
	if (branchHolder !== undefined) {
		return {
			ok: true,
			action: 'create',
			feature_id: args.feature_id,
			worktree_path: branchHolder.path,
			branch,
			created: false,
			reused: true,
			note:
				`${branch} is already checked out at ${branchHolder.path} — git keeps one worktree per branch, so that directory is this feature's write area. ` +
				'Dispatch there; the package "worktree" must name this exact path.',
		}
	}

	if (await hasBranch(git, root, branch, exec.signal)) {
		await git.ok(['worktree', 'add', path, branch], { cwd: root, signal: exec.signal, timeoutMs: SLOW_GIT_TIMEOUT_MS }, 'git worktree add')
	} else {
		const argv = ['worktree', 'add', path, '-b', branch]
		if (args.base !== undefined) argv.push(args.base)
		await git.ok(argv, { cwd: root, signal: exec.signal, timeoutMs: SLOW_GIT_TIMEOUT_MS }, 'git worktree add')
	}
	await ensureGitignore(ctx, root, exec)
	return {
		ok: true,
		action: 'create',
		feature_id: args.feature_id,
		worktree_path: path,
		branch,
		created: true,
		reused: false,
		note: bootstrapped,
	}
}

/**
 * action "merge": integrate the feature branch into a target branch.
 *
 * @param {object} ctx
 * @param {object} args
 * @param {object} exec
 */
async function mergeBranch(ctx, args, exec) {
	if (args.into !== undefined) assertSlug(args.into, 'into')
	const { git, root } = await repositoryFor(ctx, exec)
	const branch = `feature/${args.feature_id}`
	if (!(await hasBranch(git, root, branch, exec.signal))) {
		throw new Error(`no local branch ${branch}; nothing to merge.`)
	}
	const current = (await git.ok(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal: exec.signal })).stdout.trim()
	let target = current
	if (current === branch) {
		// The primary tree itself is checked out on the feature branch (a manual
		// checkout, or an area retired without merging): integration has to leave
		// it first, and only the caller knows where the work belongs.
		if (args.into === undefined) {
			throw new Error(
				`already on ${branch} in the primary tree: pass ` +
					'into: "<the branch this work should land on>" to merge it there.',
			)
		}
		target = args.into
	} else if (args.into !== undefined && args.into !== current) {
		target = args.into
	}
	if (target !== current) {
		if (!(await hasBranch(git, root, target, exec.signal))) throw new Error(`no local branch ${target}.`)
		await git.ok(['checkout', target], { cwd: root, signal: exec.signal }, `git checkout ${target}`)
	}
	const before = (await git.ok(['rev-parse', 'HEAD'], { cwd: root, signal: exec.signal })).stdout.trim()

	const merge = await git.run(['merge', '--no-edit', branch], {
		cwd: root,
		signal: exec.signal,
		timeoutMs: SLOW_GIT_TIMEOUT_MS,
	})
	if (merge.exitCode !== 0) {
		// Read the conflicted paths before aborting, or they are gone.
		const files = await unmergedFiles(git, root, exec.signal).catch(() => [])
		await git.run(['merge', '--abort'], { cwd: root, signal: exec.signal }).catch(() => {})
		return { ok: false, action: 'merge', feature_id: args.feature_id, branch, merged: false, conflict: true, files, into: target, reason: merge.stderr.trim() }
	}

	const diff = await git.ok(['diff', '--name-only', before, 'HEAD'], { cwd: root, signal: exec.signal })
	const files = diff.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
	return { ok: true, action: 'merge', feature_id: args.feature_id, branch, merged: true, conflict: false, files, into: target, reason: '' }
}

/**
 * action "remove": drop the write area (the branch always survives).
 *
 * @param {object} ctx
 * @param {object} args
 * @param {object} exec
 */
async function removeArea(ctx, args, exec) {
	const { git, root } = await repositoryFor(ctx, exec)
	const path = normalizeGitPath(join(root, WORKTREES_DIR, args.feature_id))
	const target = (await listWorktrees(git, root, exec.signal)).find(entry => entry.path === path)
	if (target === undefined) {
		return { ok: true, action: 'remove', feature_id: args.feature_id, removed: false, skipped: true, dirty: [], worktree_path: null, branch: null }
	}

	const dirty = await dirtyFiles(git, target.path, exec.signal)
	if (dirty.length > 0) {
		return {
			ok: false,
			action: 'remove',
			feature_id: args.feature_id,
			removed: false,
			dirty,
			worktree_path: target.path,
			branch: target.branch ?? null,
		}
	}

	await git.ok(['worktree', 'remove', target.path], { cwd: root, signal: exec.signal, timeoutMs: SLOW_GIT_TIMEOUT_MS }, 'git worktree remove')
	await git.run(['worktree', 'prune'], { cwd: root, signal: exec.signal })
	return {
		ok: true,
		action: 'remove',
		feature_id: args.feature_id,
		removed: true,
		dirty: [],
		worktree_path: target.path,
		branch: target.branch ?? null,
	}
}
