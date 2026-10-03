/**
 * Standalone exercise of the orch-lite host plugin (v0.3): the worktree tools,
 * the feature/explore gate, skill registration, and boot context injection.
 *
 * The package cannot be installed from this session (the desktop profile is
 * Electron-owned and `plugin_manager` is Creator-mode only), so this harness
 * stubs just enough of `ctx` — subprocess, fs, tools, systemPrompt, skills,
 * the agents registry, and the event bus — to drive the real `lib/index.js`
 * against a real git repository and a fake tool dispatch.
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

// Keep the plugin's durable audit trail out of the real harness home: the path
// is resolved at module load from DSH_HOME (else ~/.dsh), as dsh-home-paths does.
const auditHome = mkdtempSync(join(tmpdir(), 'orch-home-'))
process.env.DSH_HOME = auditHome

// The bundle has two halves: the preset row (`lib/index.js` — protocol section,
// boot injection, gate) and the host row (`lib/host.js` — the two manuals AND
// the `orch_tool` work-area tool, registered globally so every preset can use
// them).
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
const logs = []
const TOOL_VISIBLE_SCOPES = new Set(['orch-preset-mount'])
const toolsService = {
	register: tool => {
		registered.set(tool.name, tool)
		TOOL_VISIBLE_SCOPES.add('orch-preset-mount')
	},
	get: (name, scope) => (TOOL_VISIBLE_SCOPES.has(scope) && registered.has(name) ? registered.get(name) : undefined),
}
const agentsService = { map: new Map(), get(id) { return this.map.get(id) } }
const ctx = {
	subprocess,
	fs: fsService,
	tools: toolsService,
	systemPrompt: { section: section => sections.push(section) },
	skills: { register: skill => skills.set(skill.name, skill) },
	logger: { warn: message => warnings.push(message), info: message => logs.push(message) },
	get: name => (name === 'agents' ? agentsService : undefined),
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
const emitPost = async (exec, result) => {
	for (const listener of listeners.get('tools/post-execute') ?? []) {
		await listener({ ...exec, signal: new AbortController().signal }, result, async () => ({ kind: 'allow' }))
	}
}
const gate = async (exec) => {
	let nextCalled = false
	let decision
	for (const listener of listeners.get('tools/pre-execute') ?? []) {
		decision = await listener({ ...exec, signal: new AbortController().signal }, async () => {
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

// a live feature worktree so gate existence-checks pass for `login`
mkdirSync(join(root, '.worktrees', 'login'), { recursive: true })
await git(['worktree', 'add', join(root, '.worktrees', 'login'), '-b', 'feature/login', '-q'])

const exec = { signal: new AbortController().signal, agent: MAIN }
const call = (name, args) => registered.get(name).execute(args, exec)
// One tool, three actions: the work-area operations are all orch_tool.
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
	check('protocol carries supremacy + routing audit', body.includes('## Supremacy') && body.includes('[routing] chat'))
	check('protocol carries the ownership model', body.includes('## Ownership model: one feature, one agent, one branch') && body.includes('[routing] resume <feature_id>'))
	check('protocol states lazy isolation', body.includes('## Isolation is gated on concurrency') && body.includes('Solo** (no other worker running)'))
	check('protocol carries the language rule', body.includes('Answer the user in whatever language the user writes in'))
	check('protocol demands the skill load', body.includes('Call the skill tool with name `orch-lite`'))
	check('protocol carries both lanes', body.includes('acceptance_criteria') && body.includes('orch-lite-executor') && body.includes('explore'))
}

// --- skills -----------------------------------------------------------------

check('the two halves inject different services', hostHalf.inject.includes('skills') && hostHalf.inject.includes('tools') && !presetHalf.inject.includes('skills'), JSON.stringify({ preset: presetHalf.inject, host: hostHalf.inject }))
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
}

// --- freshness guards: shipped text must match the shipped tool ------------------

{
	const read = relative => readFileSync(join(pkg, ...relative.split('/')), 'utf8')
	const shipped = [
		'lib/index.js',
		'lib/host.js',
		'lib/tool.js',
		'lib/workspace.js',
		'lib/gate.js',
		'skills/orch-lite/SKILL.md',
		'skills/orch-lite-executor/SKILL.md',
		'presets/orch-lite.patch.yml',
	]
	const stale = shipped.filter(relative => /worktree_(create|merge|remove)/.test(read(relative)))
	check('no shipped file still names the retired per-action tools', stale.length === 0, stale.join(', '))
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
	const toolSource = read('lib/tool.js')
	check(
		'the tool description says it works outside the preset without enforcement',
		toolSource.includes('nothing enforces the discipline'),
	)
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

// --- boot context -------------------------------------------------------------

{
	const injected = []
	const fakeAgent = { session: { header: { id: 'fresh-main', cwd: root, agentPreset: 'orch-lite', delegationDepth: 0 } }, inject: m => injected.push(m) }
	await emit('agent/created', { agent: fakeAgent, source: 'startup' })
	check('main session gets the boot contract', injected.length === 1 && injected[0].content[0].text.includes('Session mode: ORCHESTRATION'))
	check('boot contract carries the ownership rule', injected[0].content[0].text.includes('one feature_id = one agent = one branch'))
	check('boot contract carries lazy isolation', injected[0].content[0].text.includes('Isolation is lazy'))
	const injectedChild = []
	const fakeChild = { session: { header: { id: 'fresh-child', cwd: root, agentPreset: 'orch-lite', delegationDepth: 1, parentSession: 'fresh-main' } }, inject: m => injectedChild.push(m) }
	await emit('agent/created', { agent: fakeChild, source: 'subagent' })
	check('worker gets the mode-neutral hint', injectedChild[0]?.content?.[0]?.text?.includes('dispatched worker'))
	check('hint covers both lanes', injectedChild[0].content[0].text.includes('orch-lite-executor') && injectedChild[0].content[0].text.includes('read-only'))
	await emit('agent/created', { agent: { session: { header: { id: 'x', cwd: root, agentPreset: 'standard' } }, inject: () => check('standard session must not be touched', false) }, source: 'startup' })
	check('non-orch-lite sessions are ignored', true)
}

// --- gate: main session write/shell -------------------------------------------

{
	const write = await gate({ agent: MAIN, name: 'write', arguments: { path: 'a.txt', content: 'x' } })
	check('gate denies main write', write.decision?.kind === 'deny' && write.decision?.reason?.includes('never writes'))
	check('denials are audited to the host log', logs.some((line) => line.includes('orch-lite gate: deny (main write)')), logs.join(' | '))
	const edit = await gate({ agent: MAIN, name: 'edit', arguments: {} })
	check('gate denies main edit', edit.decision?.kind === 'deny')
	const rm = await gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'Remove-Item app.js' } })
	check('gate denies mutating shell', rm.decision?.kind === 'deny' && rm.decision?.reason?.includes('dispatch-only'))
	const gc = await gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'git -c user.name=x commit -qm m' } })
	check('gate denies git commit', gc.decision?.kind === 'deny')
	const read = await gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'Get-ChildItem | Select-Object Name' } })
	check('gate passes read-only shell', read.nextCalled)
	const stat = await gate({ agent: MAIN, name: 'bash', arguments: { command: 'git status && git log -n 3 && git branch' } })
	check('gate passes git status/log/branch-list', stat.nextCalled)
	const diff = await gate({ agent: MAIN, name: 'bash', arguments: { command: 'git diff -- app.js > /dev/null 2>&1' } })
	check('gate passes git diff with /dev/null redirect', diff.nextCalled)
	const out = await gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'rg -n "version" app.js > hits.txt' } })
	check('gate denies output redirection to a file', out.decision?.kind === 'deny')
	const install = await gate({ agent: MAIN, name: 'bash', arguments: { command: 'npm install left-pad' } })
	check('gate denies package installs', install.decision?.kind === 'deny')
	const mergeTool = await gate({ agent: MAIN, name: 'orch_tool', arguments: { action: 'merge', feature_id: 'login' } })
	check('gate passes the integration tool', mergeTool.nextCalled)
}

// --- gate: feature dispatch ----------------------------------------------------

{
	const featurePrompt = (pkg) =>
		'You are the login feature agent.\nFirst call the skill tool with name orch-lite-executor and follow it.\n' +
		'```json\n' + JSON.stringify(pkg) + '\n```'
	const good = featurePrompt({ feature_id: 'login', objective: 'o', acceptance_criteria: ['c'], worktree: '.worktrees/login' })
	const r1 = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: good } })
	check('gate passes a compliant feature package', r1.nextCalled, r1.decision?.reason)
	const r2 = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'Login feature', prompt: good } })
	check('gate rejects description != feature_id', r2.decision?.kind === 'deny' && r2.decision.reason.includes('feature_id'))
	const r3 = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'x', prompt: 'prose, no fence' } })
	check('gate rejects a missing package', r3.decision?.kind === 'deny' && r3.decision.reason.includes('fenced'))
	const r4 = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: good.replace('orch-lite-executor', 'other') } })
	check('gate rejects a missing handbook pointer', r4.decision?.kind === 'deny' && r4.decision.reason.includes('handbook'))
	const noWorktree = featurePrompt({ feature_id: 'login', objective: 'o', acceptance_criteria: ['c'] })
	const r5 = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: noWorktree } })
	check('solo dispatch needs no worktree when nothing else runs', r5.nextCalled, r5.decision?.reason)
	// the allowed solo dispatch reserved a pending slot; a second solo in the
	// same burst (before the first child registers) must be refused
	const beta = featurePrompt({ feature_id: 'beta', objective: 'o', acceptance_criteria: ['c'] })
	const r5b = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'beta', prompt: beta } })
	check('a second solo dispatch is refused while the first is still starting', r5b.decision?.kind === 'deny' && r5b.decision.reason.includes('already running'), r5b.decision?.reason)
	// a dispatch that failed to start a child releases its slot at post-execute
	await emitPost({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: noWorktree } }, { content: [{ type: 'text', text: 'Error: provider rejected the spawn' }] })
	const r5c = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'beta', prompt: beta } })
	check('the solo lane reopens after the failed dispatch released its slot', r5c.nextCalled, r5c.decision?.reason)
	// beta now holds a slot; a SUCCESS ack must not release it (start will)
	await emitPost({ agent: MAIN, name: 'subagent', arguments: { description: 'beta', prompt: beta } }, { content: [{ type: 'text', text: 'started subagent child-beta-1' }] })
	const BETA = { session: { header: { id: 'child-beta', cwd: root, agentPreset: 'orch-lite', delegationDepth: 1, parentSession: 'main-1' } } }
	agentsService.map.set('run-beta', BETA)
	await emit('subagent/start', { id: 'run-beta', runId: 'run-beta' })
	await emit('subagent/end', { id: 'run-beta', runId: 'run-beta' })
	agentsService.map.delete('run-beta')
	const ghost = featurePrompt({ feature_id: 'ghost', objective: 'o', acceptance_criteria: ['c'], worktree: '.worktrees/ghost' })
	const r6 = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'ghost', prompt: ghost } })
	check('gate rejects a worktree that does not exist', r6.decision?.kind === 'deny' && r6.decision.reason.includes('does not exist'), r6.decision?.reason)
	const badShape = featurePrompt({ feature_id: 'login', objective: 'o', acceptance_criteria: ['c'], worktree: '.worktrees/other' })
	const r7 = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: badShape } })
	check('gate rejects a worktree that is not this feature\'s', r7.decision?.kind === 'deny' && r7.decision.reason.includes('.worktrees/login'))
}

// --- gate: parent-grouped concurrency (cross-session immunity) --------------------

{
	const otherChild = { session: { header: { id: 'child-of-other', cwd: root, agentPreset: 'orch-lite', delegationDepth: 1, parentSession: 'other-main' } } }
	agentsService.map.set('run-o1', otherChild)
	await emit('subagent/start', { id: 'run-o1', runId: 'run-o1' })
	const probe =
		'You are the delta feature agent.\nFirst call the skill tool with name orch-lite-executor and follow it.\n```json\n' +
		JSON.stringify({ feature_id: 'delta', objective: 'o', acceptance_criteria: ['c'] }) + '\n```'
	const r = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'delta', prompt: probe } })
	check("another session's live worker does not close my solo lane", r.nextCalled, r.decision?.reason)
	await emitPost({ agent: MAIN, name: 'subagent', arguments: { description: 'delta', prompt: probe } }, { content: [{ type: 'text', text: 'Error: provider rejected the spawn' }] })
	await emit('subagent/end', { id: 'run-o1', runId: 'run-o1' })
	agentsService.map.delete('run-o1')
}

// --- gate: explore dispatch ------------------------------------------------------

{
	const ok =
		'Wide sweep of the auth flow.\n```json\n{ "objective": "find every token validation site" }\n```\n' +
		'This is a read-only investigation; do not change any file. Report with file:line references.'
	const e1 = await gate({ agent: MAIN, name: 'explore', arguments: { description: 'trace-auth', prompt: ok } })
	check('gate passes a compliant explore call', e1.nextCalled, e1.decision?.reason)
	const e2 = await gate({ agent: MAIN, name: 'explore', arguments: { description: 'trace-auth', prompt: ok.replace(/read-only[^.]*\./, 'check it out.') } })
	check('gate rejects an explore without the read-only statement', e2.decision?.kind === 'deny' && e2.decision.reason.includes('read-only'))
	const e3 = await gate({ agent: MAIN, name: 'explore', arguments: { description: 'trace-auth', prompt: ok.replace('```json\n{ "objective": "find every token validation site" }', '```json\n{ "objective": "x", "worktree": ".worktrees/login" }') } })
	check('gate rejects a explore carrying a worktree', e3.decision?.kind === 'deny' && e3.decision.reason.includes('read-only lane') === false && e3.decision.reason.includes('must not carry'))
	const e4 = await gate({ agent: MAIN, name: 'explore', arguments: { description: 'x', prompt: 'no structure at all' } })
	check('gate rejects an explore with no package', e4.decision?.kind === 'deny')
}

// --- gate: executors -------------------------------------------------------------

{
	agentsService.map.set('run-1', CHILD)
	await emit('subagent/start', { id: 'run-1', runId: 'run-1' })
	const w = await gate({ agent: CHILD, name: 'write', arguments: { path: 'x', content: 'y' } })
	check('executors may write', w.nextCalled)
	const d = await gate({ agent: CHILD, name: 'subagent', arguments: { description: 'x', prompt: 'whatever' } })
	check('executors may not dispatch further', d.decision?.kind === 'deny' && d.decision.reason.includes('depth budget'))
	const e = await gate({ agent: CHILD, name: 'explore', arguments: { description: 'x', prompt: 'whatever' } })
	check('executors may not spawn explores', e.decision?.kind === 'deny')
	const t = await gate({ agent: CHILD, name: 'spawn_teammate', arguments: {} })
	check('executors may not create teams', t.decision?.kind === 'deny')
	// lazy isolation, concurrent half: while this worker is live, a worktree-less
	// dispatch must be refused
	const concurrent = await gate({
		agent: MAIN,
		name: 'subagent',
		arguments: {
			description: 'payment',
			prompt:
				'You are the payment feature agent.\nFirst call the skill tool with name orch-lite-executor and follow it.\n```json\n' +
				JSON.stringify({ feature_id: 'payment', objective: 'o', acceptance_criteria: ['c'] }) +
				'\n```',
		},
	})
	check('a worktree-less dispatch is refused while another worker runs', concurrent.decision?.kind === 'deny' && concurrent.decision.reason.includes('already running'), concurrent.decision?.reason)
	await emit('subagent/end', { id: 'run-1', runId: 'run-1' })
	const soloAgain = await gate({
		agent: MAIN,
		name: 'subagent',
		arguments: {
			description: 'payment',
			prompt:
				'You are the payment feature agent.\nFirst call the skill tool with name orch-lite-executor and follow it.\n```json\n' +
				JSON.stringify({ feature_id: 'payment', objective: 'o', acceptance_criteria: ['c'] }) +
				'\n```',
		},
	})
	check('the solo lane reopens once the worker settles', soloAgain.nextCalled, soloAgain.decision?.reason)
}

// --- gate: unknown agents pass ----------------------------------------------------

{
	const r = await gate({ name: 'write', arguments: {} })
	check('host-local calls (no agent) pass', r.nextCalled)
	check('unattributable gated calls are logged as fail-open', logs.some((line) => line.includes('fail-open')))
	const foreign = { session: { header: { id: 'f', cwd: root, agentPreset: 'standard' } } }
	const r2 = await gate({ agent: foreign, name: 'write', arguments: {} })
	check('foreign-preset sessions pass untouched', r2.nextCalled)
}

// --- slug validation ----------------------------------------------------------

await rejects('rejects a path-traversal feature_id', () => callTool('create', { feature_id: '../escape' }))
await rejects('rejects an uppercase feature_id', () => callTool('create', { feature_id: 'FixLogin' }))
await rejects('rejects a feature_id with a separator', () => callTool('create', { feature_id: 'a/b' }))
await rejects('rejects an unknown action', () => callTool('frobnicate', { feature_id: 'login' }))

// --- create (reuses the fixture worktree) / idempotence ------------------------

const created = await callTool('create', { feature_id: 'login' })
check('create is idempotent on the live feature worktree', created.created === false && created.reused === true)
check('worktree path follows the feature', created.worktree_path.endsWith('/.worktrees/login'), created.worktree_path)
check('branch follows the feature', created.branch === 'feature/login', created.branch)

// --- a new feature gets a fresh area -------------------------------------------

const fresh = await callTool('create', { feature_id: 'docs' })
check('a new feature creates its area', fresh.created === true && fresh.branch === 'feature/docs')
check('fresh worktree directory exists', existsSync(join(root, '.worktrees', 'docs', 'app.js')))
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
check('remove refuses a dirty worktree', refused.removed === false && refused.dirty.includes('dirty.txt'), JSON.stringify(refused.dirty))
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
check('remove deletes a clean worktree', removed.removed === true)
check('the directory is gone', !existsSync(join(root, '.worktrees', 'rival')))
const branches = await git(['branch', '--list', 'feature/*'])
check('remove keeps the branch', branches.includes('feature/rival'), branches.trim())

// --- solo lane: branch in the primary tree, merge with `into`, nothing to remove

await git(['checkout', '-b', 'feature/solo', '-q'])
writeFileSync(join(root, 'solo.txt'), 'solo work\n', 'utf8')
await git(['add', 'solo.txt'])
await git(['-c', 'user.name=solo', '-c', 'user.email=solo@orch-lite.local', 'commit', '-qm', 'feat: solo work'])
await rejects('solo merge demands the base branch when `into` is omitted', () => callTool('merge', { feature_id: 'solo' }))
const soloMerge = await callTool('merge', { feature_id: 'solo', into: 'main' })
check('solo merge switches to the base and merges', soloMerge.merged === true && soloMerge.into === 'main', JSON.stringify(soloMerge))
check('the primary tree is back on main', (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() === 'main')
check('solo changes landed on the base branch', existsSync(join(root, 'solo.txt')))
const soloRemove = await callTool('remove', { feature_id: 'solo' })
check('remove is a no-op for solo work', soloRemove.skipped === true && soloRemove.removed === false, JSON.stringify(soloRemove))
check(
	'the no-op render explains the solo lane',
	registered.get('orch_tool').output.render({}, soloRemove)[0].text.includes('primary working tree'),
)

// --- a fresh (non-repository) folder: lazy bootstrap -----------------------------

const bare = mkdtempSync(join(tmpdir(), 'orch-norepo-'))
const bareExec = { signal: new AbortController().signal, agent: { session: { header: { cwd: bare, id: 'no-repo' } } } }
writeFileSync(join(bare, 'notes.txt'), 'user content\n', 'utf8')
// merge must never bootstrap: it fails, and leaves no repository behind
await rejects('merge refuses a non-repository workspace', () => registered.get('orch_tool').execute({ action: 'merge', feature_id: 'x' }, bareExec))
check('the merge attempt created no repository', !existsSync(join(bare, '.git')))
const bootstrapped = await registered.get('orch_tool').execute({ action: 'create', feature_id: 'scratch' }, bareExec)
check('create bootstraps a repository in a fresh folder', bootstrapped.created === true && bootstrapped.branch === 'feature/scratch', JSON.stringify(bootstrapped))
check('the repository now exists', existsSync(join(bare, '.git')))
check('the feature worktree is on disk', existsSync(join(bare, '.worktrees', 'scratch')))
const bareLog = (await git(['log', '--format=%s'], bare)).trim()
check('a baseline commit exists', bareLog.includes('chore: orch-lite baseline'), bareLog)
const tracked = (await git(['ls-files'], bare)).trim()
check('user files stay untracked (only .gitignore was claimed)', !tracked.includes('notes.txt'), tracked)
check('the user file is untouched', readFileSync(join(bare, 'notes.txt'), 'utf8').includes('user content'))
check('the bootstrap is logged', logs.some((line) => line.includes('bootstrapped a git repository')))
check('ignored entries were written', readFileSync(join(bare, '.gitignore'), 'utf8').includes('.worktrees/'))

// --- the durable audit trail ------------------------------------------------------

const auditFile = join(auditHome, 'orch-lite', 'audit.log')
check('a durable audit trail exists', existsSync(auditFile), auditFile)
const auditText = existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : ''
check('denials reach the trail', auditText.includes('deny (main write)'))
check('the solo-lane decision reaches the trail', auditText.includes('allow (solo lane'))
check('the bootstrap reaches the trail', auditText.includes('bootstrapped a git repository'))

rmSync(root, { recursive: true, force: true })
rmSync(bare, { recursive: true, force: true })
rmSync(auditHome, { recursive: true, force: true })

console.log(`\n${passed}/${passed + failed} passed`)
if (warnings.length > 0) console.log(`warnings: ${warnings.join(' | ')}`)
process.exit(failed === 0 ? 0 : 1)
