/**
 * Git access for the worktree tools — the plugin's only subprocess boundary.
 * Every git call goes through here so the platform-specific concerns stay in
 * one place: argv instead of a shell string (so PowerShell ConstrainedLanguage
 * never applies), the harness environment scrub, per-call deadlines, and
 * bounded output.
 */

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2_000
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024
/** Default per-call deadline. A worktree add on a cold disk is the slow case. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Default stdout cap. Generous, but bounded: a runaway `git log` must not exhaust memory. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/**
 * Inherited `GIT_*` selectors that would point git at a different repository,
 * index, object store, attribute tree or replacement-ref base than the one the
 * session is working in. The harness scrubs its own copy for library-level git,
 * but this plugin is a separate process boundary: a `GIT_DIR` inherited from a
 * hook, an IDE or a wrapping shell would silently retarget every call here.
 *
 * `undefined` is how this boundary says "do not pass it on" — the subprocess
 * service drops an overlay entry whose value is undefined, so the child starts
 * without the variable at all.
 *
 * Matches the shipped `@deepseek-ai/dsh-experimental-worktree` service.
 */
export const GIT_ENV_SCRUB = [
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_COMMON_DIR',
	'GIT_INDEX_FILE',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_CONFIG',
	'GIT_CONFIG_PARAMETERS',
	'GIT_CEILING_DIRECTORIES',
	'GIT_PREFIX',
	'GIT_SHALLOW_FILE',
	'GIT_GRAFT_FILE',
	'GIT_REPLACE_REF_BASE',
	'GIT_ATTR_SOURCE',
]

/**
 * Git options carried by **every** invocation: repository-configured hooks and
 * the fsmonitor daemon are the user's tooling, not plumbing this plugin may run
 * on its own behalf. A `post-checkout`/`reference-transaction` hook that does
 * anything slow, interactive or destructive would otherwise fire inside an
 * allocation the plugin promised to be bounded.
 *
 * `/dev/null` is the same spelling the shipped worktree service uses: git looks
 * for a hooks *directory* there, finds none, and runs no hook on any platform.
 */
export const GIT_NEUTRAL_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

/**
 * Attribute names a filter driver can define. All four are blanked (or pinned
 * to `false`) for the one call that materialises a checkout, so a repository's
 * filter driver cannot run during allocation.
 */
const FILTER_ATTRIBUTES = ['clean', 'smudge', 'process', 'required']

/** Prefix every repository filter-driver config key carries. */
const FILTER_PREFIX = 'filter.'

/**
 * The fixed part of the child environment.
 *
 * `GIT_CONFIG_COUNT: '0'` after the scrub is deliberate rather than redundant:
 * the scrub also drops inherited `GIT_CONFIG_KEY_n` config by zeroing the count
 * git is willing to read, and a per-call override may raise it again with keys
 * this plugin chose.
 */
const GIT_ENV = {
	...Object.fromEntries(GIT_ENV_SCRUB.map(key => [key, undefined])),
	GIT_CONFIG_COUNT: '0',
	GIT_TERMINAL_PROMPT: '0',
	// No lazy object/commit fetch, and LFS never filters a checkout this plugin
	// performs: both would reach the network inside a bounded, offline-ish call.
	GIT_NO_LAZY_FETCH: '1',
	GIT_LFS_SKIP_SMUDGE: '1',
	// Optional locks off keeps read-only commands from taking `.git/index.lock`
	// while a worker holds it; LC_ALL pins the message text we diagnose from.
	GIT_OPTIONAL_LOCKS: '0',
	LC_ALL: 'C',
}

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
	 * @param {object} [options.env] command-local environment overrides, applied
	 *   after the inherited-environment scrub (see {@link filterNeutralizingEnv})
	 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, truncated: boolean}>}
	 * @throws when the call times out, is aborted, or cannot spawn.
	 */
	async run(args, options = {}) {
		const timeoutMs = options.timeoutMs ?? this.timeoutMs
		const timeout = AbortSignal.timeout(timeoutMs)
		const signal = AbortSignal.any([options.signal, timeout])
		const handle = this.subprocess.spawn({
			argv: [this.executable, ...GIT_NEUTRAL_ARGS, ...args],
			cwd: options.cwd,
			stdio: {
				stdin: 'ignore',
				stdout: { maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES },
				stderr: { maxBytes: STDERR_TAIL_BYTES },
			},
			graceMs: TERMINATE_GRACE_MS,
			signal,
			// The inherited-environment scrub drops ambient repository, index,
			// object-store and command-line config selectors; the rest of the
			// block pins git's non-interactive, offline, locale-stable behavior.
			env: { ...GIT_ENV, ...options.env },
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
 * Resolve a revision to the object name of the commit it designates.
 *
 * `--end-of-options` keeps a revision that looks like an option from being read
 * as one, and `^{commit}` refuses a tag or tree that does not peel to a commit —
 * the caller wants nothing but a commit here.
 *
 * @param {GitRunner} git
 * @param {string} cwd
 * @param {string} revision commit-ish, e.g. `HEAD`, a branch, a tag
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} full commit object name
 */
export async function resolveCommit(git, cwd, revision, signal) {
	const { stdout } = await git.ok(
		['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
		{ cwd, signal },
		`git rev-parse ${revision}`,
	)
	const commit = stdout.trim()
	if (commit === '') throw new Error(`git rev-parse ${revision} named no commit.`)
	return commit
}

/**
 * Environment overrides that neutralise every repository-configured filter
 * driver for **one** call — the `reset --hard` that materialises a fresh
 * checkout.
 *
 * A clean/smudge/process driver is arbitrary code named by the repository's
 * config, and `worktree add --no-checkout` followed by `reset --hard` is exactly
 * the moment it would run. Rather than edit the user's config, each driver's
 * attributes are blanked through command-line config (`GIT_CONFIG_KEY_n` /
 * `GIT_CONFIG_VALUE_n`): a driver whose commands are empty is skipped, and
 * `required=false` stops git from failing on a driver that was left configured.
 *
 * Drivers come from local, global and system config, because all three can run
 * code during checkout; this is the same set the shipped worktree service
 * blanks.
 *
 * @param {GitRunner} git
 * @param {string} cwd working tree to read the effective configuration from
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} env overlay to pass as `run(..., { env })`
 */
export async function filterNeutralizingEnv(git, cwd, signal) {
	const result = await git.run(['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], { cwd, signal })
	// Exit 1 means "no key matched" — a repository with no filter driver at all.
	if (result.exitCode === 1) return {}
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || `exit ${result.exitCode}`
		throw new Error(`git config --get-regexp ^filter\\. failed: ${detail}`)
	}
	const drivers = new Set()
	for (const key of result.stdout.split('\0')) {
		const separator = key.lastIndexOf('.')
		if (separator <= FILTER_PREFIX.length) continue
		if (!FILTER_ATTRIBUTES.includes(key.slice(separator + 1))) continue
		drivers.add(key.slice(FILTER_PREFIX.length, separator))
	}
	if (drivers.size === 0) return {}
	const env = { GIT_CONFIG_COUNT: String(drivers.size * FILTER_ATTRIBUTES.length) }
	let index = 0
	for (const driver of drivers) {
		for (const attribute of FILTER_ATTRIBUTES) {
			env[`GIT_CONFIG_KEY_${index}`] = `${FILTER_PREFIX}${driver}.${attribute}`
			env[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
			index++
		}
	}
	return env
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
 * Local branches matching an optional glob pattern.
 *
 * @param {GitRunner} git
 * @param {string} cwd
 * @param {string} [pattern] e.g. `feature/*`; omitted lists every local branch
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>} branch names without `refs/heads/`
 */
export async function listBranches(git, cwd, pattern, signal) {
	const args = ['branch', '--list']
	if (pattern !== undefined && pattern !== '') args.push(pattern)
	const { stdout } = await git.ok(args, { cwd, signal }, 'git branch --list')
	return stdout
		.split(/\r?\n/)
		// `*` marks the current branch, `+` marks a branch checked out in another
		// worktree — neither is part of the name.
		.map(line => line.replace(/^[*+]\s*/, '').trim())
		.filter(line => line !== '')
}

/**
 * Branches already merged into a given ref.
 *
 * The ref matters: `git branch --merged` without one judges against HEAD, and
 * after a fast-forward integration HEAD already carries the feature — so the
 * answer would be true for every branch and mean nothing. Naming the
 * integration branch asks the real question: is this feature's work already
 * on the line it was supposed to land on?
 *
 * @param {GitRunner} git
 * @param {string} cwd
 * @param {string} ref branch to judge against, e.g. `main`
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>}
 */
export async function mergedBranches(git, cwd, ref, signal) {
	const { stdout } = await git.ok(['branch', '--merged', ref], { cwd, signal }, 'git branch --merged')
	return stdout
		.split(/\r?\n/)
		.map(line => line.replace(/^[*+]\s*/, '').trim())
		.filter(line => line !== '' && line !== '(no branch)')
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
