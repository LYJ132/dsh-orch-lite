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
				'Use something like login or fix-login. The same string names the branch, the work area and the package field.',
		)
	}
}

/**
 * Validate a branch name (allows slashes for hierarchical names like release/1.0,
 * but rejects path traversal attempts and leading dashes).
 *
 * @param {string} value
 * @param {string} field parameter name for the message
 */
export function assertBranchName(value, field) {
	if (typeof value !== 'string' || value === '') {
		throw new Error(`${field} must be a non-empty string, got ${JSON.stringify(value)}.`)
	}
	if (value.startsWith('-')) {
		throw new Error(`${field} must not start with '-', got ${JSON.stringify(value)}.`)
	}
	if (value.includes('..')) {
		throw new Error(`${field} must not contain path traversal (..), got ${JSON.stringify(value)}.`)
	}
	// Basic sanity: no spaces, no control chars, no shell metacharacters that could be risky.
	// Git branch names allow a wide range; we only block the clearly dangerous ones.
	if (/[\s\177~`!@#$%^&*()=+{[}\]|:;"'<,>?]/.test(value)) {
		throw new Error(`${field} contains invalid characters, got ${JSON.stringify(value)}.`)
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
 * The bootstrap ONLY runs when the directory is EMPTY (or contains nothing
 * but our own artifacts: `.git`, `.gitignore`, `.worktrees/`). If the directory
 * holds user files, we refuse to create a repository and return a notice
 * explaining why — a scattered `.git` in a user's folder is not reversible by
 * a local git command. See DEVLOG.md.
 *
 * The returned object contains the user-facing notice and a success flag.
 * The notice travels in the tool result so the model must repeat it to the user.
 * See DEVLOG.md § v1.1.0.
 *
 * @param {object} ctx
 * @param {import('./git.js').GitRunner} git
 * @param {string} cwd session working directory
 * @param {object} exec
 * @returns {Promise<{notice: string, success: boolean}>}
 */
async function bootstrapRepository(ctx, git, cwd, exec) {
	// Guard: only bootstrap an EMPTY directory (or one that already has our own
	// artifacts). If the user has files here, do not turn their folder into a
	// repository.
	//
	// The fs service exposes `listDir` (not `readDir`); an entry is
	// `{ name, type, target }`. A failure to LIST is not a licence to
	// bootstrap: the directory may hold files we simply could not enumerate, so
	// an unreadable directory is refused, not adopted.
	const allowed = new Set(['.git', '.gitignore', '.worktrees'])
	let hasUserFiles = true
	try {
		const target = await ctx.fs.resolve(cwd, { cwd, signal: exec.signal })
		const entries = await ctx.fs.listDir(target, exec.signal)
		hasUserFiles = entries.some(entry => !allowed.has(entry.name))
	} catch (error) {
		ctx.logger.warn(`orch-lite: could not list ${cwd}: ${String(error)}`)
	}
	if (hasUserFiles) {
		const notice = `Refused to bootstrap a git repository at ${cwd}: the directory is not empty. ` +
			'Create the repository yourself, or run the write task in an empty folder. ' +
			'A scattered .git is not something a local git command can undo.'
		ctx.logger.warn(`orch-lite: ${notice}`)
		return { notice, success: false }
	}

	const options = { cwd, signal: exec.signal }
	const attempt = await git.run(['init', '-b', 'main'], options)
	if (attempt.exitCode !== 0) {
		// Older git without `-b`: init, then rename the unborn branch.
		const plain = await git.run(['init'], options)
		if (plain.exitCode !== 0) {
			ctx.logger.warn(`orch-lite: git bootstrap failed at ${cwd}: ${(plain.stderr || attempt.stderr).trim()}`)
			return { notice: '', success: false }
		}
		await git.run(['branch', '-m', 'main'], options)
	}
	const root = await repoRoot(git, cwd, exec.signal)
	if (root === undefined) return { notice: '', success: false }
	await ensureGitignore(ctx, root, exec)
	await git.run(['add', '.gitignore'], options)
	const commit = await git.run([...BOOTSTRAP_IDENTITY, 'commit', '--allow-empty', '-m', 'chore: orch-lite baseline'], options)
	if (commit.exitCode !== 0) ctx.logger.warn(`orch-lite: baseline commit failed at ${root}: ${commit.stderr.trim()}`)
	return {
		notice: (
			`Bootstrapped a git repository at ${root} — init -b main plus a baseline commit staging only .gitignore, ` +
			'so existing files stay untracked. State in your report that the directory became a git repository.'
		),
		success: true
	}
}

/**
 * When the session cwd is not itself inside a repository, look for exactly
 * one repository among the immediate subdirectories. This covers the case
 * where the session opens in a parent folder (a workspace root, a downloads
 * directory) and the real repo lives one level down — `git rev-parse` only
 * walks UP, so without this the tool sees "no repository" and tries to
 * bootstrap the parent, which is non-empty and gets refused.
 *
 * Returns the root, or undefined when there is zero (nothing to use) or more
 * than one (ambiguous — refuse rather than guess).
 *
 * @param {object} ctx
 * @param {import('./git.js').GitRunner} git
 * @param {string} cwd
 * @param {object} exec
 * @returns {Promise<string|undefined>}
 */
export async function findRepoInSubdirs(ctx, git, cwd, exec) {
	const skip = new Set(['node_modules', '.git', '.worktrees'])
	let entries
	try {
		const target = await ctx.fs.resolve(cwd, { cwd, signal: exec.signal })
		entries = await ctx.fs.listDir(target, exec.signal)
	} catch {
		return undefined
	}
	const found = []
	for (const entry of entries) {
		if (entry.type !== 'directory') continue
		if (skip.has(entry.name)) continue
		const root = await repoRoot(git, join(cwd, entry.name), exec.signal)
		if (root !== undefined) found.push({ name: entry.name, root })
	}
	return found.length === 1 ? found[0].root : undefined
}

/**
 * Resolve the git runner and the repository root for the calling session.
 *
 * Three-resolution strategy:
 * 1. `git rev-parse --show-toplevel` from the session cwd (walks UP);
 * 2. if that finds nothing, scan immediate subdirectories for exactly one
 *    repository (the session opened in a parent folder);
 * 3. if still nothing and `create: true`, bootstrap the minimum repository
 *    in an empty folder.
 *
 * `create: true` (action "create" only) is the only call site allowed to
 * bootstrap. merge/remove/list/doctor never bootstrap — a non-repository
 * workspace gets the explicit "nothing to isolate" error.
 *
 * If bootstrap is refused (directory not empty), the refusal notice is
 * returned in `bootstrapped` and `root` remains undefined — the caller must
 * handle this.
 *
 * @param {object} ctx
 * @param {object} exec
 * @param {{create?: boolean}} [options]
 * @returns {Promise<{git: import('./git.js').GitRunner, root: string|undefined, bootstrapped: string}>}
 */
export async function repositoryFor(ctx, exec, options = {}) {
	const cwd = sessionCwd(exec)
	if (cwd === undefined) throw new Error('no session working directory on this agent; the orch-lite tool needs a real session.')
	const git = await createGitRunner(ctx)
	let root = await repoRoot(git, cwd, exec.signal)
	if (root === undefined) {
		// The session cwd is not inside a repository. Maybe the repo is an
		// immediate subdirectory — the session opened in a parent folder.
		root = await findRepoInSubdirs(ctx, git, cwd, exec)
	}
	let bootstrapped = ''
	let bootstrapRefused = false
	if (root === undefined && options.create === true) {
		const result = await bootstrapRepository(ctx, git, cwd, exec)
		bootstrapped = result.notice
		bootstrapRefused = !result.success
		if (result.success) {
			root = await repoRoot(git, cwd, exec.signal)
		}
	}
	if (root === undefined && !bootstrapRefused) {
		throw new Error(
			`${cwd} is not inside a git repository, and no repository was found in its immediate subdirectories. ` +
				'Dispatch read-only work with explore instead — write work needs a repository.',
		)
	}
	return { git, root, bootstrapped }
}
