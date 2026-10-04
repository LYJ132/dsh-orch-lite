/**
 * Repository and work-area plumbing for the orch-lite tool: resolve the calling
 * session's repository (bootstrapping the minimum one when a write task needs
 * isolation), validate feature ids, and keep `.worktrees/` out of the user's
 * `git status`.
 *
 * Lives outside `lib/index.js` because the tool is registered by the HOST row
 * (`lib/host.js`, global to every preset) while the gate and protocol stay in
 * the preset row. Package: dsh-orch-lite. Decision history: see DEVLOG.md.
 */

import { join } from 'node:path'
import { SLUG } from './gate.js'
import { createGitRunner, repoRoot } from './git.js'

/** Worktrees live under this directory in the repository root. */
export const WORKTREES_DIR = '.worktrees'

/** Worktree add and merge are the slow calls; give them room on a cold disk. */
export const SLOW_GIT_TIMEOUT_MS = 120_000

/** Synthetic identity for the baseline commit — a fresh machine has no git user. */
const BOOTSTRAP_IDENTITY = ['-c', 'user.name=orch-lite-init', '-c', 'user.email=orch-lite@local']

/**
 * Reject a value that cannot safely become a branch name or path segment.
 *
 * @param {string} value
 * @param {string} field parameter name for the message
 */
export function assertSlug(value, field) {
	if (!SLUG.test(value)) {
		throw new Error(
			`${field} must be lowercase kebab-case (letters, digits, single hyphens; 1-63 chars), got ${JSON.stringify(value)}. ` +
				'Use something like login or fix-login. The same string is the agent description, the branch, and the worktree directory.',
		)
	}
}

/**
 * The calling session's working directory.
 *
 * @param {object} exec tool execution context
 * @returns {string|undefined}
 */
export function sessionCwd(exec) {
	return exec.agent?.session?.header?.cwd
}

/**
 * Whether an error is a missing-path error from the filesystem service.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNotFound(error) {
	return typeof error === 'object' && error !== null && (error.code === 'FS_NOT_FOUND' || error.code === 'ENOENT')
}

/**
 * Whether `.gitignore` already carries an entry for a directory.
 *
 * @param {string} content
 * @param {string} entry slash form, e.g. `.worktrees/`
 * @returns {boolean}
 */
function hasIgnoreEntry(content, entry) {
	const bare = entry.replace(/\/$/, '')
	return content.split(/\r?\n/).some(line => {
		const trimmed = line.trim()
		return trimmed === entry || trimmed === bare || trimmed === `/${entry}` || trimmed === `/${bare}`
	})
}

/**
 * Add `.worktrees/` to `.gitignore` so concurrent worktrees never show up as
 * untracked noise in the main tree. Idempotent; a failure here must not fail
 * the worktree creation.
 *
 * @param {object} ctx
 * @param {string} root repository top level
 * @param {object} exec
 */
export async function ensureGitignore(ctx, root, exec) {
	const entries = [`/${WORKTREES_DIR}/`, `.worktrees/`]
	const path = join(root, '.gitignore')
	const resolveOptions = { cwd: root, signal: exec.signal }
	try {
		const target = await ctx.fs.resolve(path, resolveOptions)
		const current = await ctx.fs.readText(target, exec.signal)
		const missing = entries.filter(entry => !hasIgnoreEntry(current, entry))
		if (missing.length === 0) return
		const head = current === '' || current.endsWith('\n') ? current : `${current}\n`
		await ctx.fs.writeText(target, head + missing.map(entry => `${entry}\n`).join(''), undefined, exec.signal)
	} catch (error) {
		if (!isNotFound(error)) return
		try {
			const target = await ctx.fs.resolve(path, resolveOptions)
			await ctx.fs.writeText(target, entries.map(entry => `${entry}\n`).join(''), undefined, exec.signal)
		} catch {
			// A repository that cannot hold a .gitignore is not this tool's problem.
		}
	}
}

/**
 * Create the minimum repository a work area needs, mirroring the original
 * orch-lite bootstrap (`git init -b main`, ignore entries, a baseline commit).
 * It stages ONLY `.gitignore` and commits with `--allow-empty`, so the user's
 * existing files stay untracked — the bootstrap never claims user content.
 * Failures are warnings; the caller still reports the missing repository.
 *
 * The returned sentence is the user-facing notice: a directory becoming a
 * repository also changes DSH's own project-root resolution, so the model has
 * to be told it happened — and say so in its report. That is why it travels in
 * the tool result instead of a log file: see DEVLOG.md § v1.1.0.
 *
 * @param {object} ctx
 * @param {import('./git.js').GitRunner} git
 * @param {string} cwd session working directory
 * @param {object} exec
 * @returns {Promise<string>} the notice, '' when nothing was created
 */
async function bootstrapRepository(ctx, git, cwd, exec) {
	const options = { cwd, signal: exec.signal }
	const attempt = await git.run(['init', '-b', 'main'], options)
	if (attempt.exitCode !== 0) {
		// Older git without `-b`: init, then rename the unborn branch.
		const plain = await git.run(['init'], options)
		if (plain.exitCode !== 0) {
			ctx.logger.warn(`orch-lite: git bootstrap failed at ${cwd}: ${(plain.stderr || attempt.stderr).trim()}`)
			return ''
		}
		await git.run(['branch', '-m', 'main'], options)
	}
	const root = await repoRoot(git, cwd, exec.signal)
	if (root === undefined) return ''
	await ensureGitignore(ctx, root, exec)
	await git.run(['add', '.gitignore'], options)
	const commit = await git.run([...BOOTSTRAP_IDENTITY, 'commit', '--allow-empty', '-m', 'chore: orch-lite baseline'], options)
	if (commit.exitCode !== 0) ctx.logger.warn(`orch-lite: baseline commit failed at ${root}: ${commit.stderr.trim()}`)
	return (
		`Bootstrapped a git repository at ${root} — init -b main plus a baseline commit staging only .gitignore, ` +
		'so existing files stay untracked. State in your report that the directory became a git repository.'
	)
}

/**
 * Resolve the git runner and the repository root for the calling session.
 *
 * `create: true` (action "create" only) lazily bootstraps the minimum
 * repository when the workspace has none. The original ran that bootstrap at
 * every session start; here it fires only when a write task actually needs
 * isolation, so chat/read-only sessions and directories that should not be
 * repositories stay untouched. merge/remove never bootstrap.
 *
 * @param {object} ctx
 * @param {object} exec
 * @param {{create?: boolean}} [options]
 * @returns {Promise<{git: import('./git.js').GitRunner, root: string, bootstrapped: string}>}
 */
export async function repositoryFor(ctx, exec, options = {}) {
	const cwd = sessionCwd(exec)
	if (cwd === undefined) throw new Error('no session working directory on this agent; the orch-lite tool needs a real session.')
	const git = await createGitRunner(ctx)
	let root = await repoRoot(git, cwd, exec.signal)
	let bootstrapped = ''
	if (root === undefined && options.create === true) {
		bootstrapped = await bootstrapRepository(ctx, git, cwd, exec)
		root = await repoRoot(git, cwd, exec.signal)
	}
	if (root === undefined) {
		throw new Error(
			`${cwd} is not inside a git repository, so there is nothing to isolate with a work area. ` +
				'Dispatch read-only work with explore instead — write work needs a repository.',
		)
	}
	return { git, root, bootstrapped }
}
