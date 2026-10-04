/**
 * Standalone exercise of the orch-lite host plugin (v1.1): the work-area tool,
 * the slim gate (worker lane + external effects + opt-in package), skill
 * registration, and the worker hint.
 *
 * The package cannot be installed from this session (the desktop profile is
 * Electron-owned and `plugin_manager` is Creator-mode only), so this harness
 * stubs just enough of `ctx` — subprocess, fs, tools, systemPrompt, skills and
 * the event bus — to drive the real `lib/index.js` against a real git repository
 * and a fake tool dispatch.
 *
 * Usage: node test/plugin.test.mjs <path-to-dsh-orch-lite>
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pkg = process.argv[2]
if (pkg === undefined) {
	console.error('usage: node test/plugin.test.mjs <path-to-dsh-orch-lite>')
	process.exit(2)
}

// The bundle has two halves: the preset row (`lib/index.js` — protocol section,
// worker hint, gate) and the host row (`lib/host.js` — the two manuals AND the
// `orch_tool` work-area tool, registered globally so every preset can use them).
const presetHalf = await import(pathToFileURL(join(pkg, 'lib', 'index.js')).href)
const hostHalf = await import(pathToFileURL(join(pkg, 'lib', 'host.js')).href)

// ---------------------------------------------------------------- stub ctx

const subprocess = {
	resolveExecutable: async name => name,
	spawn({ argv, cwd, stdio, signal }) {
		const child = execFile(argv[0], argv.slice(1), { cwd, signal, maxBuffer: 64 * 1024 * 1024 })
		let out = ''
		let err = ''
		child.stdout?.on('data', chunk => {
			out += chunk
		})
		child.stderr?.on('data', chunk => {
			err += chunk
		})
		const done = new Promise(resolve => {
			child.on('close', code => resolve({ exitCode: code, signal: null }))
			child.on('error', error => resolve({ exitCode: -1, error }))
		})
		const reader = buffer => ({ readFrom: () => ({ text: buffer(), lossy: false }) })
		return {
			done,
			collected: { stdout: reader(() => out), stderr: reader(() => err) },
			terminate: () => child.kill(),
		}
	},
}

const fsService = {
	resolve: async path => ({ displayPath: path }),
	stat: async target => {
		if (!existsSync(target.displayPath)) {
			const error = new Error(`ENOENT: ${target.displayPath}`)
			error.code = 'FS_NOT_FOUND'
			throw error
		}
		return { size: readFileSync(target.displayPath).length }
	},
	readText: async target => {
		if (!existsSync(target.displayPath)) {
			const error = new Error(`ENOENT: ${target.displayPath}`)
			error.code = 'FS_NOT_FOUND'
			throw error
		}
		return readFileSync(target.displayPath, 'utf8')
	},
	writeText: async (target, content) => {
		writeFileSync(target.displayPath, content, 'utf8')
		return { version: String(content.length), operation: 'written' }
	},
}

const registered = new Map()
const sections = []
const skills = new Map()
const listeners = new Map()
const warnings = []
const TOOL_VISIBLE_SCOPES = new Set(['orch-preset-mount'])
const toolsService = {
	register: tool => {
		registered.set(tool.name, tool)
		TOOL_VISIBLE_SCOPES.add('orch-preset-mount')
	},
	get: (name, scope) => (TOOL_VISIBLE_SCOPES.has(scope) && registered.has(name) ? registered.get(name) : undefined),
}
const ctx = {
	subprocess,
	fs: fsService,
	tools: toolsService,
	systemPrompt: { section: section => sections.push(section) },
	skills: { register: skill => skills.set(skill.name, skill) },
	logger: { warn: message => warnings.push(message) },
	get: () => undefined,
	on: (point, listener) => {
		if (!listeners.has(point)) listeners.set(point, [])
		listeners.get(point).push(listener)
	},
}

presetHalf.apply(ctx)
hostHalf.apply(ctx)

// ------------------------------------------------------------------ helpers

const emit = async (point, payload) => {
	for (const listener of listeners.get(point) ?? []) await listener(payload)
}
const gate = (exec) => {
	let nextCalled = false
	let decision
	for (const listener of listeners.get('tools/pre-execute') ?? []) {
		decision = listener({ ...exec, signal: new AbortController().signal }, () => {
			nextCalled = true
			return { kind: 'allow' }
		})
		if (decision !== undefined && decision !== null) break
	}
	return { decision, nextCalled }
}
const MAIN = { session: { header: { id: 'main-1', cwd: 'REPLACED', agentPreset: 'orch-lite', delegationDepth: 0 } } }
const CHILD = { session: { header: { id: 'child-1', cwd: 'REPLACED', agentPreset: 'orch-lite', delegationDepth: 1, parentSession: 'main-1' } } }

// -------------------------------------------------------------------- fixture

const root = mkdtempSync(join(tmpdir(), 'orch-test-'))
MAIN.session.header.cwd = root
CHILD.session.header.cwd = root
const git = (args, cwd = root) =>
	new Promise((resolve, reject) => {
		execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_COUNT: '0' } }, (error, stdout, stderr) =>
			error ? reject(new Error(`git ${args.join(' ')}: ${stderr || error.message}`)) : resolve(stdout),
		)
	})

writeFileSync(join(root, 'app.js'), 'export const version = 1\n', 'utf8')
writeFileSync(join(root, 'README.md'), '# demo\n', 'utf8')
await git(['init', '-b', 'main', '-q'])
await git(['add', '.'])
await git(['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'baseline'])

// the login feature's live work area
mkdirSync(join(root, '.worktrees'), { recursive: true })
await git(['worktree', 'add', join(root, '.worktrees', 'login'), '-b', 'feature/login', '-q'])

const exec = { signal: new AbortController().signal, agent: MAIN }
const callTool = (action, args) => registered.get('orch_tool').execute({ action, ...args }, exec)

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
	if (condition) {
		passed++
		console.log(`[PASS] ${name}`)
	} else {
		failed++
		console.log(`[FAIL] ${name}${detail === '' ? '' : ` — ${detail}`}`)
	}
}
const rejects = async (name, fn) => {
	try {
		await fn()
		check(name, false, 'expected a rejection, got success')
	} catch (error) {
		check(name, true, String(error.message).slice(0, 120))
	}
}

// --- registration -----------------------------------------------------------

check('the one work-area tool is registered by the host half', [...registered.keys()].join(',') === 'orch_tool', [...registered.keys()].join(', '))
check('the tool takes the three actions', ['create', 'merge', 'remove'].every(a => registered.get('orch_tool').parameters.properties.action.enum.includes(a)))
const protocol = sections.find(s => s.name === 'orch-lite:protocol')
check('protocol section at order 2850, interpolate false', protocol?.order === 2850 && protocol?.interpolate === false)
check('protocol has no silent empty state (no scope guard)', typeof protocol?.text === 'function' && protocol.text({ scope: 'any-scope' }).startsWith('# Mode: orch-lite'))
{
	const body = protocol?.text({ scope: 'orch-preset-mount' }) ?? ''
	check('protocol states the coordinator may write its own files', body.includes('## Where you may act') && body.includes('Your own project files: write freely'))
	check('protocol names the two denials', body.includes('.worktrees/<feature_id>/`: denied') && body.includes('outside the repository: denied'))
	check('protocol carries routing audit + ownership + always-work-area', body.includes('[routing] chat') && body.includes('## Ownership: one feature, one agent, one branch') && body.includes('## Every write task gets its own work area'))
	check('protocol carries the language rule', body.includes('Answer the user in whatever language the user writes in'))
	check('protocol demands the skill load', body.includes('Call the skill tool with name `orch-lite`'))
	check('protocol carries both lanes', body.includes('acceptance_criteria') && body.includes('orch-lite-executor') && body.includes('explore'))
	// The old blanket claim is the exact thing that locked other skills out.
	check('protocol no longer claims the main session never writes', !body.includes('never writes files'), body.match(/.{0,60}never writes.{0,20}/)?.[0] ?? '')
}

// --- skills -----------------------------------------------------------------

check('the preset half needs only systemPrompt', presetHalf.inject.join(',') === 'systemPrompt', JSON.stringify(presetHalf.inject))
check('the host half injects the capability services', hostHalf.inject.includes('skills') && hostHalf.inject.includes('tools') && hostHalf.inject.includes('subprocess'))
check('the host half names itself for the host row', hostHalf.name === 'orch-lite-host')
check('both skills registered', skills.has('orch-lite') && skills.has('orch-lite-executor'), [...skills.keys()].join(', '))
{
	const s = skills.get('orch-lite')
	check('skill content is the manual body (no frontmatter)', typeof s?.content === 'string' && s.content.startsWith('# Mode: orch-lite') && !s.content.includes('\nname: orch-lite\n---'))
	check('skill description from frontmatter', typeof s?.description === 'string' && s.description.length > 40)
	check('feature-agent scoping noted in executor description', skills.get('orch-lite-executor').description.includes('feature'))
	check(
		'skills carry a directory resource base (relative reads resolve)',
		s?.resourceBase?.kind === 'directory' && s.resourceBase.path.endsWith('dsh-orch-lite'),
		JSON.stringify(s?.resourceBase),
	)
	check('skill descriptions survive the 500-char catalog cap', [...skills.values()].every(skill => skill.description.length <= 500), [...skills.values()].map(skill => `${skill.name}:${skill.description.length}`).join(', '))
}

// --- freshness guards: shipped text must match the shipped behavior ------------------

{
	const read = relative => readFileSync(join(pkg, ...relative.split('/')), 'utf8')
	// lib/audit.js was deleted in v1.1.0; the scan list is the shipped surface, so
	// the retired mechanism may only survive in the history documents.
	const shipped = [
		'lib/index.js',
		'lib/host.js',
		'lib/tool.js',
		'lib/workspace.js',
		'lib/gate.js',
		'lib/git.js',
		'skills/orch-lite/SKILL.md',
		'skills/orch-lite-executor/SKILL.md',
		'presets/orch-lite.patch.yml',
	]
	const retired = ['worktree_create', 'worktree_merge', 'worktree_remove', 'audit.log', 'BOOT_CONTRACT', 'EXECUTOR_DENIED_TOOLS', 'WORKTREE_REQUIRED_WHILE_BUSY', 'evaluateExplore', 'solo lane', 'never writes files']
	const stale = shipped.flatMap(relative => retired.filter(term => read(relative).includes(term)).map(term => `${relative}: ${term}`))
	check('no shipped file still names a retired mechanism', stale.length === 0, stale.join(', '))
	const importers = shipped.filter(relative => /from '\.\/audit\.js'|require\('.\/audit\.js'\)/.test(read(relative)))
	check('the retired audit module is imported by nothing', importers.length === 0, importers.join(', '))
	const manual = read('skills/orch-lite/SKILL.md')
	const handbook = read('skills/orch-lite-executor/SKILL.md')
	check('the coordinator manual stays under the pruner threshold', manual.length < 8192, String(manual.length))
	check('the handbook stays under the pruner threshold', handbook.length < 8192, String(handbook.length))
	check(
		'both manuals state where enforcement exists (scope note)',
		manual.includes('Only sessions bound to the `orch-lite` preset') &&
			handbook.includes('only** in a session bound to the `orch-lite` preset'),
	)
	check(
		'the manual makes continuation conditional on agent addressability',
		manual.includes('takes `target`') && manual.includes('continuation is unavailable'),
	)
	check(
		'the handbook gives no bootstrap recipe (one repository truth: the tool)',
		!handbook.includes('git init'),
	)
	const toolSource = read('lib/tool.js')
	check(
		'the tool description says it works outside the preset without enforcement',
		toolSource.includes('nothing enforces the discipline'),
	)
	check('the tool description requires a work area for every write task', toolSource.includes('before dispatching any write task'))
}

// --- packaging: the global skills+tool split must survive regenerate/repack -----

{
	const yml = readFileSync(join(pkg, 'presets', 'orch-lite.patch.yml'), 'utf8')
	check(
		'the preset patch carries the host row',
		yml.includes('- id: orch-lite-host') && yml.includes("'dsh-orch-lite/host'"),
	)
	check('the patch uses no tabs', !yml.includes('\t'))
	check('the patch ends with a newline', yml.endsWith('\n'))
	check('the preset description is a safe YAML plain scalar', /^ {8}description: [^'"].*: /m.test(yml) === false, yml.match(/^ {8}description: .*$/m)?.[0]?.slice(0, 90) ?? '')
	// indentation is the structure: 4 = insert-list entries, 10 = preset plugin rows
	check('the preset row sits at the insert-list level', /^ {4}- id: preset-orch-lite$/m.test(yml))
	check(
		'the host row is the preset row\'s sibling, not nested inside it',
		/^ {4}- id: orch-lite-host$/m.test(yml) && /^ {6}name: 'dsh-orch-lite\/host'$/m.test(yml),
	)
	check(
		'our two rows sit inside the preset plugin list',
		/^ {10}- id: orch$/m.test(yml) && /^ {10}- id: tool-subagent-explore$/m.test(yml),
	)
	check(
		'the copied standard composition is intact',
		['persona', 'tool-fs', 'skill-filesystem', 'tool-skill', 'tool-plugin-manager'].every(id => new RegExp(`^ {10}- id: ${id}$`, 'm').test(yml)) &&
			// the delegation group nests its children one level deeper
			/^ {14}- id: tool-subagent$/m.test(yml) &&
			(yml.match(/^ {10}- id: /gm) ?? []).length >= 21,
		`rows at 10 spaces: ${(yml.match(/^ {10}- id: /gm) ?? []).length}`,
	)
	const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
	check('the manifest exports the host subpath', manifest.exports?.['./host'] === './lib/host.js')
	check('the pack file list includes the module directory', Array.isArray(manifest.files) && manifest.files.includes('lib'))
}
check('no registration warnings', warnings.length === 0, warnings.join(' | '))

// --- worker hint --------------------------------------------------------------

{
	const injected = []
	const fakeMain = { session: { header: { id: 'fresh-main', cwd: root, agentPreset: 'orch-lite', delegationDepth: 0 } }, inject: m => injected.push(m) }
	await emit('agent/created', { agent: fakeMain, source: 'startup' })
	check('the main session gets no boot contract (the protocol section is always visible)', injected.length === 0, JSON.stringify(injected))
	const injectedChild = []
	const fakeChild = { session: { header: { id: 'fresh-child', cwd: root, agentPreset: 'orch-lite', delegationDepth: 1, parentSession: 'fresh-main' } }, inject: m => injectedChild.push(m) }
	await emit('agent/created', { agent: fakeChild, source: 'subagent' })
	check('worker gets the reporting hint', injectedChild[0]?.content?.[0]?.text?.includes('dispatched worker'))
	check('the hint fixes the reporting channel', injectedChild[0].content[0].text.includes('ENDING YOUR TURN'))
	check('the hint does not restate a dispatch ban (the platform caps depth)', !injectedChild[0].content[0].text.includes('Never dispatch'))
	await emit('agent/created', { agent: { session: { header: { id: 'x', cwd: root, agentPreset: 'standard' } }, inject: () => check('standard session must not be touched', false) }, source: 'startup' })
	check('non-orch-lite sessions are ignored', true)
}

// --- gate: main-session writes --------------------------------------------------

{
	const own = gate({ agent: MAIN, name: 'write', arguments: { file_path: join(root, 'src', 'app.ts'), content: 'x' } })
	check('the coordinator may write its own project files', own.nextCalled, own.decision?.reason)
	const ownRelative = gate({ agent: MAIN, name: 'edit', arguments: { file_path: 'README.md' } })
	check('a relative project path passes too', ownRelative.nextCalled)
	const lane = gate({ agent: MAIN, name: 'write', arguments: { file_path: join(root, '.worktrees', 'login', 'app.js'), content: 'x' } })
	check('gate denies writing into a worker lane', lane.decision?.kind === 'deny' && lane.decision.reason.includes('worker lane'), lane.decision?.reason)
	const laneRelative = gate({ agent: MAIN, name: 'edit', arguments: { file_path: '.worktrees/login/app.js' } })
	check('the lane test covers relative paths as well', laneRelative.decision?.kind === 'deny')
	const laneDir = gate({ agent: MAIN, name: 'write', arguments: { file_path: '.worktrees' } })
	check('the lane directory itself is denied', laneDir.decision?.kind === 'deny')
	const lookalike = gate({ agent: MAIN, name: 'write', arguments: { file_path: 'worktrees/login/app.js' } })
	check('a directory merely named like the lane passes', lookalike.nextCalled, lookalike.decision?.reason)
	const otherPathKey = gate({ agent: MAIN, name: 'write', arguments: { path: '.worktrees/login/app.js' } })
	check('the other file-path argument name is honoured', otherPathKey.decision?.kind === 'deny')
	const noPath = gate({ agent: MAIN, name: 'write', arguments: {} })
	check('a write the gate cannot read passes (fail open)', noPath.nextCalled)
}

// --- gate: shell ----------------------------------------------------------------

{
	const push = gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'git -c user.name=x push origin main' } })
	check('gate denies git push', push.decision?.kind === 'deny' && push.decision.reason.includes('outside the repository'), push.decision?.reason)
	const publish = gate({ agent: MAIN, name: 'bash', arguments: { command: 'npm publish --access public' } })
	check('gate denies package publishing', publish.decision?.kind === 'deny')
	const gh = gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'gh pr create --title x' } })
	check('gate denies a github write (gh pr)', gh.decision?.kind === 'deny')
	const ghRead = gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'gh run view 12345' } })
	check('a gh read passes', ghRead.nextCalled, ghRead.decision?.reason)
	const laneWipe = gate({ agent: MAIN, name: 'bash', arguments: { command: 'rm -rf .worktrees/login' } })
	check('gate denies destroying a work area from the shell', laneWipe.decision?.kind === 'deny', laneWipe.decision?.reason)
	const laneRead = gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'Get-ChildItem .worktrees | Select-Object Name' } })
	check('reading the lane directory passes', laneRead.nextCalled, laneRead.decision?.reason)
	// The commands that used to be blocked and are the coordinator's ordinary work:
	for (const [label, command] of [
		['git commit', 'git add . && git commit -qm "fix: thing"'],
		['git checkout', 'git checkout -b feature/scratch'],
		['git merge', 'git merge --no-edit feature/login'],
		['install', 'pnpm install --frozen-lockfile'],
		['redirect into a project file', 'rg -n "version" app.js > hits.txt'],
		['project delete', 'Remove-Item src/old.ts'],
	]) {
		const r = gate({ agent: MAIN, name: 'pwsh', arguments: { command } })
		check(`in-repo work passes (${label})`, r.nextCalled, r.decision?.reason)
	}
	const read = gate({ agent: MAIN, name: 'bash', arguments: { command: 'git status && git log -n 3 && git branch' } })
	check('gate passes git status/log/branch-list', read.nextCalled)
	const mergeTool = gate({ agent: MAIN, name: 'orch_tool', arguments: { action: 'merge', feature_id: 'login' } })
	check('gate passes the integration tool', mergeTool.nextCalled)
}

// --- gate: dispatch is opt-in ----------------------------------------------------

{
	const featurePrompt = (body) =>
		'You are the login feature agent.\nFirst call the skill tool with name orch-lite-executor and follow it.\n' +
		'```json\n' + JSON.stringify(body) + '\n```'
	const good = featurePrompt({ feature_id: 'login', objective: 'o', acceptance_criteria: ['c'], worktree: '.worktrees/login' })
	check('gate passes a compliant feature package', gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: good } }).nextCalled)
	check(
		'gate rejects description != feature_id',
		gate({ agent: MAIN, name: 'subagent', arguments: { description: 'Login feature', prompt: good } }).decision?.kind === 'deny',
	)
	check(
		'gate rejects a missing handbook pointer',
		gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: featurePrompt({ feature_id: 'login', objective: 'o', acceptance_criteria: ['c'], worktree: '.worktrees/login' }).replace('orch-lite-executor', 'other') } }).decision?.reason.includes('handbook'),
	)
	const noWorktree = featurePrompt({ feature_id: 'login', objective: 'o', acceptance_criteria: ['c'] })
	const missingArea = gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: noWorktree } })
	check('a feature package without a work area is refused (S2)', missingArea.decision?.kind === 'deny' && missingArea.decision.reason.includes('worktree'), missingArea.decision?.reason)
	const missingField = gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: featurePrompt({ feature_id: 'login', objective: 'o' }) } })
	check('a feature package missing acceptance_criteria is refused', missingField.decision?.kind === 'deny')
	const badId = gate({ agent: MAIN, name: 'subagent', arguments: { description: 'Login', prompt: featurePrompt({ feature_id: 'Login', objective: 'o', acceptance_criteria: ['c'], worktree: '.worktrees/login' }) } })
	check('a non-kebab feature_id is refused', badId.decision?.kind === 'deny')
	const prose = gate({ agent: MAIN, name: 'subagent', arguments: { description: 'summarize notes', prompt: 'Read memory/session.md and append today’s decisions. No structured package here.' } })
	check('a dispatch that is not a feature package passes (opt-in contract)', prose.nextCalled, prose.decision?.reason)
	const otherSkill = gate({ agent: MAIN, name: 'subagent_fork', arguments: { description: 'remember', prompt: 'Load the memory skill and store this preference in the memory file.' } })
	check("another skill's own dispatch convention passes", otherSkill.nextCalled, otherSkill.decision?.reason)
	const claimsButNoFence = gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: 'feature_id: login — but no fenced package at all' } })
	check('claiming a feature_id without a package is told why', claimsButNoFence.decision?.kind === 'deny' && claimsButNoFence.decision.reason.includes('feature_id'), claimsButNoFence.decision?.reason)
	// M9 removed: explore carries no contract the gate could police.
	const looseExplore = gate({ agent: MAIN, name: 'explore', arguments: { description: 'trace-auth', prompt: 'Find every token validation site and report with file:line.' } })
	check('explore is no longer package-gated', looseExplore.nextCalled, looseExplore.decision?.reason)
}

// --- gate: children are not routed ------------------------------------------------

{
	const w = gate({ agent: CHILD, name: 'write', arguments: { file_path: '.worktrees/login/app.js', content: 'y' } })
	check('a worker writes inside its own area', w.nextCalled)
	const d = gate({ agent: CHILD, name: 'subagent', arguments: { description: 'x', prompt: 'whatever' } })
	check('a worker dispatch is left to the platform depth setting', d.nextCalled, d.decision?.reason)
	const t = gate({ agent: CHILD, name: 'spawn_teammate', arguments: {} })
	check('the plugin does not re-implement the Lead-only rule', t.nextCalled)
	const p = gate({ agent: CHILD, name: 'workflow', arguments: {} })
	check('the plugin does not gate workflow either', p.nextCalled)
}

// --- gate: unknown agents pass ------------------------------------------------------

{
	check('host-local calls (no agent) pass', gate({ name: 'write', arguments: {} }).nextCalled)
	const foreign = { session: { header: { id: 'f', cwd: root, agentPreset: 'standard' } } }
	check('foreign-preset sessions pass untouched', gate({ agent: foreign, name: 'write', arguments: { file_path: '.worktrees/login/x' } }).nextCalled)
}

// --- slug validation ----------------------------------------------------------

await rejects('rejects a path-traversal feature_id', () => callTool('create', { feature_id: '../escape' }))
await rejects('rejects an uppercase feature_id', () => callTool('create', { feature_id: 'FixLogin' }))
await rejects('rejects a feature_id with a separator', () => callTool('create', { feature_id: 'a/b' }))
await rejects('rejects an unknown action', () => callTool('frobnicate', { feature_id: 'login' }))

// --- create (reuses the live area) / idempotence -------------------------------

const created = await callTool('create', { feature_id: 'login' })
check('create is idempotent on the live work area', created.created === false && created.reused === true)
check('work area path follows the feature', created.worktree_path.endsWith('/.worktrees/login'), created.worktree_path)
check('branch follows the feature', created.branch === 'feature/login', created.branch)
check('a reused area carries no bootstrap notice', created.note === '', JSON.stringify(created.note))

// --- a new feature gets a fresh area -------------------------------------------

const fresh = await callTool('create', { feature_id: 'docs' })
check('a new feature creates its area', fresh.created === true && fresh.branch === 'feature/docs')
check('fresh work area directory exists', existsSync(join(root, '.worktrees', 'docs', 'app.js')))
check('.gitignore gained .worktrees/', readFileSync(join(root, '.gitignore'), 'utf8').includes('.worktrees/'))

// --- holder fallback when the branch lives elsewhere ----------------------------

await git(['worktree', 'add', join(root, 'legacy-place'), '-b', 'feature/relocated', '-q'])
const holder = await callTool('create', { feature_id: 'relocated' })
// the standard path .worktrees/relocated does not exist as a registered worktree,
// but the branch is already checked out elsewhere → reuse that path with a note
check('create hands back the branch holder', holder.reused === true && holder.worktree_path.endsWith('legacy-place'), JSON.stringify(holder))
check('the holder case explains itself', typeof holder.note === 'string' && holder.note.includes('worktree'), String(holder.note))
await git(['worktree', 'remove', join(root, 'legacy-place')])

// --- write in login, commit, merge, remove -------------------------------------

writeFileSync(join(root, '.worktrees', 'login', 'app.js'), 'export const version = 2\n', 'utf8')
await git(['-C', join(root, '.worktrees', 'login'), 'add', '.'])
await git(['-C', join(root, '.worktrees', 'login'), '-c', 'user.name=login', '-c', 'user.email=login@orch-lite.local', 'commit', '-qm', 'fix: colon handling'])

writeFileSync(join(root, '.worktrees', 'login', 'dirty.txt'), 'x', 'utf8')
const refused = await callTool('remove', { feature_id: 'login' })
check('remove refuses a dirty work area', refused.removed === false && refused.dirty.includes('dirty.txt'), JSON.stringify(refused.dirty))
rmSync(join(root, '.worktrees', 'login', 'dirty.txt'))

const clean = await callTool('merge', { feature_id: 'login' })
check('merge reports success', clean.merged === true && clean.conflict === false, JSON.stringify(clean))
check('merge lists the merged files', clean.files.includes('app.js'), JSON.stringify(clean.files))
check('main tree now has the merged content', readFileSync(join(root, 'app.js'), 'utf8').includes('version = 2'))

// --- merge (conflict) ----------------------------------------------------------

await callTool('create', { feature_id: 'rival' })
writeFileSync(join(root, 'app.js'), 'export const version = 3\n', 'utf8')
await git(['add', '.'])
await git(['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'main moves on'])
writeFileSync(join(root, '.worktrees', 'rival', 'app.js'), 'export const version = "rival"\n', 'utf8')
await git(['-C', join(root, '.worktrees', 'rival'), 'add', '.'])
await git(['-C', join(root, '.worktrees', 'rival'), '-c', 'user.name=rival', '-c', 'user.email=r@l', 'commit', '-qm', 'rival'])
const conflicted = await callTool('merge', { feature_id: 'rival' })
check('merge reports a conflict instead of merging', conflicted.conflict === true && conflicted.merged === false, JSON.stringify(conflicted))
check('merge names the conflicted file', conflicted.files.includes('app.js'), JSON.stringify(conflicted.files))
check('the main worktree is untouched after an aborted conflict', readFileSync(join(root, 'app.js'), 'utf8').includes('version = 3'), readFileSync(join(root, 'app.js'), 'utf8'))
check('no merge is left in progress', !existsSync(join(root, '.git', 'MERGE_HEAD')))

// --- remove (clean) -------------------------------------------------------------

const removed = await callTool('remove', { feature_id: 'rival' })
check('remove deletes a clean work area', removed.removed === true)
check('the directory is gone', !existsSync(join(root, '.worktrees', 'rival')))
const branches = await git(['branch', '--list', 'feature/*'])
check('remove keeps the branch', branches.includes('feature/rival'), branches.trim())

// --- never created: soft no-op ---------------------------------------------------

const soloRemove = await callTool('remove', { feature_id: 'never-existed' })
check('remove is a no-op when no area exists', soloRemove.skipped === true && soloRemove.removed === false, JSON.stringify(soloRemove))
check(
	'the no-op render says so',
	registered.get('orch_tool').output.render({}, soloRemove)[0].text.includes('nothing to remove'),
)

// --- merge demands a target when the primary tree sits on the branch ------------

await git(['checkout', '-b', 'feature/held', '-q'])
await rejects('merge names the branch problem when `into` is omitted', () => callTool('merge', { feature_id: 'held' }))
await git(['checkout', 'main', '-q'])
await git(['branch', '-D', 'feature/held'])

// --- a fresh (non-repository) folder: lazy bootstrap -------------------------------

const bare = mkdtempSync(join(tmpdir(), 'orch-norepo-'))
const bareExec = { signal: new AbortController().signal, agent: { session: { header: { cwd: bare, id: 'no-repo' } } } }
writeFileSync(join(bare, 'notes.txt'), 'user content\n', 'utf8')
// merge must never bootstrap: it fails, and leaves no repository behind
await rejects('merge refuses a non-repository workspace', () => registered.get('orch_tool').execute({ action: 'merge', feature_id: 'x' }, bareExec))
check('the merge attempt created no repository', !existsSync(join(bare, '.git')))
const bootstrapped = await registered.get('orch_tool').execute({ action: 'create', feature_id: 'scratch' }, bareExec)
check('create bootstraps a repository in a fresh folder', bootstrapped.created === true && bootstrapped.branch === 'feature/scratch', JSON.stringify(bootstrapped))
check('the repository now exists', existsSync(join(bare, '.git')))
check('the feature work area is on disk', existsSync(join(bare, '.worktrees', 'scratch')))
check('the bootstrap notice reaches the model through the tool result', typeof bootstrapped.note === 'string' && bootstrapped.note.includes('Bootstrapped a git repository'), String(bootstrapped.note))
check('the notice renders ahead of the dispatch hint', registered.get('orch_tool').output.render({}, bootstrapped)[0].text.includes('Bootstrapped a git repository'))
const bareLog = (await git(['log', '--format=%s'], bare)).trim()
check('a baseline commit exists', bareLog.includes('chore: orch-lite baseline'), bareLog)
const tracked = (await git(['ls-files'], bare)).trim()
check('user files stay untracked (only .gitignore was claimed)', !tracked.includes('notes.txt'), tracked)
check('the user file is untouched', readFileSync(join(bare, 'notes.txt'), 'utf8').includes('user content'))
check('ignored entries were written', readFileSync(join(bare, '.gitignore'), 'utf8').includes('.worktrees/'))

rmSync(root, { recursive: true, force: true })
rmSync(bare, { recursive: true, force: true })

console.log(`\n${passed}/${passed + failed} passed`)
if (warnings.length > 0) console.log(`warnings: ${warnings.join(' | ')}`)
process.exit(failed === 0 ? 0 : 1)
