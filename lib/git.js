/**
 * Git access for the worktree tools — the plugin's only subprocess boundary.
 * Every git call goes through here so the platform-specific concerns stay in
 * one place: argv instead of a shell string (so PowerShell ConstrainedLanguage
 * never applies), the harness environment scrub, per-call deadlines, and
 * bounded output.
 */

import { relative, resolve } from 'node:path'

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2_000
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024
/** Default per-call deadline. A worktree add on a cold disk is the slow case. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Default stdout cap. Generous, but bounded: a runaway `git log` must not exhaust memory. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** One resolved git executable, invoked as `git <args>` with no shell. */
export class GitRunner {
	constructor(subprocess, executable, timeoutMs = DEFAULT_TIMEOUT_MS) {
		this.subprocess = subprocess
		this.executable = executable
		this.timeoutMs = timeoutMs
	}

	/**
	 * Run `git <args>` to completion.
	 *
	 * @param {string[]} args git arguments; never shell-interpreted.
	 * @param {object} [options]
	 * @param {string} [options.cwd] working directory
	 * @param {AbortSignal} [options.signal] caller's cancellation
	 * @param {number} [options.maxBytes] stdout cap
	 * @param {number} [options.timeoutMs] per-call deadline override
	 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, truncated: boolean}>}
	 * @throws when the call times out, is aborted, or cannot spawn.
	 */
	async run(args, options = {}) {
		const timeoutMs = options.timeoutMs ?? this.timeoutMs
		const timeout = AbortSignal.timeout(timeoutMs)
		const signal = AbortSignal.any([options.signal, timeout])
		const handle = this.subprocess.spawn({
			argv: [this.executable, ...args],
			cwd: options.cwd,
			stdio: {
				stdin: 'ignore',
				stdout: { maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES },
				stderr: { maxBytes: STDERR_TAIL_BYTES },
			},
			graceMs: TERMINATE_GRACE_MS,
			signal,
			// The harness environment scrub drops ambient GIT_CONFIG_KEY_n entries;
			// these pin the rest of git's non-interactive, locale-stable behavior.
			env: {
				GIT_CONFIG_COUNT: '0',
				GIT_TERMINAL_PROMPT: '0',
				GIT_OPTIONAL_LOCKS: '0',
				LC_ALL: 'C',
			},
		})
		const outcome = await handle.done
		if (signal.aborted) {
			throw new Error(`git ${args.join(' ')} ${timeout.aborted ? `timed out after ${timeoutMs}ms` : 'was aborted'}`)
		}
		const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
		return {
			exitCode: outcome.exitCode,
			stdout: stdout.text,
			stderr: handle.collected.stderr?.readFrom(0).text ?? '',
			truncated: stdout.lossy,
		}
	}

	/**
	 * Run `git <args>` and reject a non-zero exit with its stderr.
	 *
	 * @param {string[]} args git arguments
	 * @param {object} [options] same shape as {@link run}
	 * @param {string} [what] command description used in the error message
	 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, truncated: boolean}>}
	 */
	async ok(args, options = {}, what = `git ${args[0]}`) {
		const result = await this.run(args, options)
		if (result.exitCode !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
			throw new Error(`${what} failed: ${detail}`)
		}
		return result
	}
}

/**
 * Resolve the git executable once and wrap it.
 *
 * @param {object} ctx plugin context providing `ctx.subprocess`
 * @param {object} [config]
 * @param {number} [config.timeoutMs] per-call deadline
 * @returns {Promise<GitRunner>}
 */
export async function createGitRunner(ctx, config = {}) {
	const executable = await ctx.subprocess.resolveExecutable('git')
	return new GitRunner(ctx.subprocess, executable, config.timeoutMs)
}

/**
 * The repository enclosing `cwd`, or `undefined` when `cwd` is not in one.
 *
 * @param {GitRunner} git
 * @param {string} cwd
 * @param {AbortSignal} [signal]
 * @returns {Promise<string|undefined>} absolute, POSIX-normalized repository top level
 */
export async function repoRoot(git, cwd, signal) {
	const result = await git.run(['rev-parse', '--show-toplevel'], { cwd, signal })
	if (result.exitCode !== 0) return undefined
	const root = result.stdout.trim()
	return root === '' ? undefined : normalizeGitPath(root)
}

/**
 * Parse `git worktree list --porcelain` into records.
 *
 * The porcelain form is one blank-line-separated block per worktree; a detached
 * checkout carries `detached` where a branch checkout carries `branch`.
 *
 * @param {GitRunner} git
 * @param {string} cwd
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{path: string, branch?: string, detached: boolean}>>}
 */
export async function listWorktrees(git, cwd, signal) {
	const { stdout } = await git.ok(['worktree', 'list', '--porcelain'], { cwd, signal }, 'git worktree list')
	const records = []
	for (const block of stdout.split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/).filter(line => line !== '')
		if (lines.length === 0) continue
		const path = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
		if (path === undefined) continue
		const branchRef = lines.find(line => line.startsWith('branch '))?.slice('branch '.length)
		records.push({
			path: normalizeGitPath(path),
			branch: branchRef === undefined ? undefined : branchRef.replace(/^refs\/heads\//, ''),
			detached: lines.includes('detached'),
		})
	}
	return records
}

/**
 * Whether a local branch exists.
 *
 * @param {GitRunner} git
 * @param {string} cwd
 * @param {string} branch branch name without `refs/heads/`
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
export async function hasBranch(git, cwd, branch, signal) {
	const result = await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, signal })
	return result.exitCode === 0
}

/**
 * The uncommitted changes in a working tree, as repo-relative paths.
 *
 * @param {GitRunner} git
 * @param {string} cwd absolute working-tree path
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>} empty when the tree is clean
 */
export async function dirtyFiles(git, cwd, signal) {
	const { stdout } = await git.ok(['status', '--porcelain'], { cwd, signal }, 'git status')
	return stdout
		.split(/\r?\n/)
		.map(line => line.slice(3).trim())
		.filter(line => line !== '')
		.map(entry => entry.includes(' -> ') ? entry.split(' -> ')[1] : entry)
}

/**
 * The files a just-created commit touched, repo-relative.
 *
 * @param {GitRunner} git
 * @param {string} cwd
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function lastCommitFiles(git, cwd, signal) {
	const { stdout } = await git.ok(['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd, signal }, 'git show')
	return stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

/**
 * The paths still in merge conflict.
 *
 * @param {GitRunner} git
 * @param {string} cwd
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function unmergedFiles(git, cwd, signal) {
	const { stdout } = await git.ok(['diff', '--name-only', '--diff-filter=U'], { cwd, signal }, 'git diff')
	return stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

/**
 * Render a path relative to `root` for display, falling back to the absolute
 * path when the target is outside the root.
 *
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
export function displayPath(root, path) {
	const rel = relative(root, path)
	if (rel === '') return '.'
	if (rel.startsWith('..')) return normalizeGitPath(path)
	return normalizeGitPath(resolve(root, rel))
}

/**
 * Normalize a path to the slash-separated form git prints, so comparisons
 * against git output match on Windows as well as POSIX.
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizeGitPath(path) {
	return path.replace(/\\/g, '/')
}
