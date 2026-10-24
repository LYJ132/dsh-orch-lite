/**
 * Repository and work-area plumbing for the orch-lite tool: resolve the calling
 * session's repository (bootstrapping the minimum one when a write task needs
 * isolation), validate feature ids, and allocate the `.worktrees/` pool with its
 * own self-ignoring `.gitignore`.
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

/**
 * The pool's own ignore file: one line, `*`.
 *
 * It is inside `.worktrees/`, so it hides the pool's entire contents from the
 * user's `git status` — including itself — without touching the repository's
 * tracked `.gitignore` (which belongs to the user). This is the shape the
 * shipped worktree service uses, and the reason this plugin no longer edits a
 * file it does not own.
 */
export const POOL_IGNORE = '*\n'

/**
 * Safety-net secret patterns for the bootstrap baseline commit. Bootstrap now
 * stages all existing files (`git add -A`) so work areas can check them out,
 * and these patterns keep credentials out of that first commit even when the
 * user has no .gitignore of their own. Deliberately conservative:
 *
 * - no `*.key` — test fixtures routinely ship public keys;
 * - no `*.secret` — too broad, would swallow legitimately tracked fixtures;
 * - `.env*` is intentionally over-broad: negate with `!.env.example` after
 *   bootstrap if you track that file.
 *
 * Only applied during bootstrap. Existing repos keep their own .gitignore
 * untouched.
 */
export const SECRET_SAFETY_NET = ['.env*', '*.pem', '*.p12', 'id_rsa*', 'id_ed25519*']

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
 * Allocate the `.worktrees/` pool and give it its own ignore file.
 *
 * `ctx.fs.writeText` creates missing parent directories, so writing
 * `<root>/.worktrees/.gitignore` allocates the pool in one step. An existing
 * pool keeps whatever ignore file it already has — the pool is shared, and a
 * later `create` must not overwrite a file another writer put there.
 *
 * Best-effort by design: an area is still usable without it, and a filesystem
 * that refuses the write is not this tool's problem. Returns whether it wrote
 * the file, which the tests assert on.
 *
 * @param {object} ctx
 * @param {string} root repository top level
 * @param {object} exec
 * @returns {Promise<boolean>} true when the ignore file was created here
 */
export async function ensurePoolIgnore(ctx, root, exec) {
	const resolveOptions = { cwd: root, signal: exec.signal }
	const path = join(root, WORKTREES_DIR, '.gitignore')
	try {
		const target = await ctx.fs.resolve(path, resolveOptions)
		await ctx.fs.readText(target, exec.signal)
		return false
	} catch (error) {
		if (!isNotFound(error)) return false
	}
	try {
		const target = await ctx.fs.resolve(path, resolveOptions)
		await ctx.fs.writeText(target, POOL_IGNORE, undefined, exec.signal)
		return true
	} catch {
		return false
	}
}

/**
 * Add entries to the repository's own tracked `.gitignore`, but only the ones
 * a bootstrap needs (the secret safety net). Work areas do **not** get an entry
 * here any more — the pool's `.gitignore` covers them, so a `create` never edits
 * a file the user owns.
 *
 * Idempotent; a failure here must not fail the caller.
 *
 * @param {object} ctx
 * @param {string} root repository top level
 * @param {object} exec
 * @param {string[]} [entries] ignore patterns to ensure (bootstrap only)
 */
export async function ensureGitignore(ctx, root, exec, entries = []) {
	if (entries.length === 0) return
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
 *
 * Owner rule (2026-10-23, supersedes the v0.6 empty-folder guard): the
 * repository is created IN the session's own working folder, always. The
 * walk-up check in `repositoryFor` is the only nesting defense — it runs
 * first, so a bootstrap here can never fire inside an existing repository.
 *
 * Since v1.1.5 the baseline commit stages ALL existing files (`git add -A`),
 * not just `.gitignore` — otherwise a worktree checked out from HEAD would
 * contain only `.gitignore` and no user code, leaving the worker blind to
 * the project. A conservative secret safety net (`SECRET_SAFETY_NET`) is
 * written into `.gitignore` first so credentials never enter the baseline.
 * The notice tells the model to say so to the user.
 *
 * The returned object contains the user-facing notice and a success flag.
 * The notice travels in the tool result so the model must repeat it to the user.
 *
 * @param {object} ctx
 * @param {import('./git.js').GitRunner} git
 * @param {string} cwd session working directory
 * @param {object} exec
 * @returns {Promise<{notice: string, success: boolean}>}
 */
async function bootstrapRepository(ctx, git, cwd, exec) {
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
	await ensureGitignore(ctx, root, exec, SECRET_SAFETY_NET)
	// The pool gets its own ignore file before anything is staged, so a
	// `.worktrees/` directory that already existed in the folder cannot leak into
	// the baseline commit — the same protection the old `.gitignore` entry gave,
	// without editing the user's file.
	await ensurePoolIgnore(ctx, root, exec)
	// Stage ALL existing files so work areas check them out. Previously only
	// .gitignore was staged, which left worktrees empty of user code. The
	// safety net above keeps credentials out; user files are now the baseline
	// and subsequent edits are trackable.
	await git.run(['add', '-A'], options)
	const commit = await git.run([...BOOTSTRAP_IDENTITY, 'commit', '-m', 'chore: orch-lite baseline'], options)
	if (commit.exitCode !== 0) ctx.logger.warn(`orch-lite: baseline commit failed at ${root}: ${commit.stderr.trim()}`)
	return {
		notice: (
			`Bootstrapped a git repository at ${root} — init -b main plus a baseline commit of all existing files ` +
			'(a secret safety net was written to .gitignore: .env*, *.pem, *.p12, id_rsa*, id_ed25519*). ' +
			'State in your report that the directory became a git repository.'
		),
		success: true
	}
}

/**
 * Resolve the git runner and the repository root for the calling session.
 *
 * Owner rule (2026-10-23): the repository lives in the session's own working
 * folder; the walk-up check (`git rev-parse --show-toplevel`) exists only to
 * prevent nesting — when the cwd is already inside a repository, that
 * repository IS the isolation base and no new one is created.
 *
 * `create: true` (action "create" only) lazily bootstraps the minimum
 * repository when the workspace has none. It fires only when a write task
 * actually needs isolation, so chat/read-only sessions and directories that
 * should not be repositories stay untouched. merge/remove never bootstrap.
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
	let bootstrapped = ''
	if (root === undefined && options.create === true) {
		const result = await bootstrapRepository(ctx, git, cwd, exec)
		bootstrapped = result.notice
		if (result.success) {
			root = await repoRoot(git, cwd, exec.signal)
		}
	}
	if (root === undefined) {
		throw new Error(
			`${cwd} is not inside a git repository and bootstrapping one here did not succeed. ` +
				'Dispatch read-only work with explore instead — write work needs a repository.',
		)
	}
	return { git, root, bootstrapped }
}
