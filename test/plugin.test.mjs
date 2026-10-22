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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
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
	listDir: async (target, signal) => {
		if (!existsSync(target.displayPath)) {
			const error = new Error(`ENOENT: ${target.displayPath}`)
			error.code = 'FS_NOT_FOUND'
			throw error
		}
		return readdirSync(target.displayPath, { withFileTypes: true }).map(entry => ({
			name: entry.name,
			type: entry.isDirectory() ? 'directory' : 'file',
			target: { displayPath: join(target.displayPath, entry.name) },
		}))
	},
	readDir: async (target, signal) => {
		if (!existsSync(target.displayPath)) {
			const error = new Error(`ENOENT: ${target.displayPath}`)
			error.code = 'FS_NOT_FOUND'
			throw error
		}
		return readdirSync(target.displayPath)
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
const gate = async (exec) => {
	let nextCalled = false
	let decision
	for (const listener of listeners.get('tools/pre-execute') ?? []) {
		decision = await listener({ ...exec, signal: new AbortController().signal }, () => {
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
check('the tool takes the five actions', ['create', 'merge', 'remove', 'list', 'doctor'].every(a => registered.get('orch_tool').parameters.properties.action.enum.includes(a)))
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
		s?.resourceBase?.kind === 'directory',
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
	const retired = ['worktree_create', 'worktree_merge', 'worktree_remove', 'audit.log', 'BOOT_CONTRACT', 'EXECUTOR_DENIED_TOOLS', 'WORKTREE_REQUIRED_WHILE_BUSY', 'evaluateExplore', 'solo lane', 'never writes files', 'one-shot', 'verbatim identical', 'settles and is gone', 'BINDING_REASON', 'description == feature_id', '[routing] explore', '[routing] orchestration']
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

// --- the version-number discipline --------------------------------------------
//
// The manifest version and the top CHANGELOG section must name the same
// release: a bump that touches one but not the other is how a "published"
// version ends up describing something else. The minor/major rule itself is
// an owner decision and cannot be asserted here — the DEVLOG records it, and
// this check makes sure the file that records it stays in place.

{
	const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
	const version = manifest.version
	const changelog = readFileSync(join(pkg, 'CHANGELOG.md'), 'utf8')
	const top = changelog.match(/^## (\d+\.\d+\.\d+)/m)
	check('the manifest version is a three-part version', /^\d+\.\d+\.\d+$/.test(version ?? ''), String(version))
	check('the CHANGELOG opens with the manifest version', top?.[1] === version, `changelog: ${top?.[1]}, manifest: ${version}`)
	const devlog = readFileSync(join(pkg, 'DEVLOG.md'), 'utf8')
	check(
		'the DEVLOG states the version-number discipline (patch is the agent\'s, minor and up are the owner\'s)',
		devlog.includes('The version-number discipline') &&
			devlog.includes('is the agent\'s call') &&
			devlog.includes("is the owner's call"),
	)
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
	const own = await gate({ agent: MAIN, name: 'write', arguments: { file_path: join(root, 'src', 'app.ts'), content: 'x' } })
	check('the coordinator may write its own project files', own.nextCalled, own.decision?.reason)
	const ownRelative = await gate({ agent: MAIN, name: 'edit', arguments: { file_path: 'README.md' } })
	check('a relative project path passes too', ownRelative.nextCalled)
	const lane = await gate({ agent: MAIN, name: 'write', arguments: { file_path: join(root, '.worktrees', 'login', 'app.js'), content: 'x' } })
	check('gate denies writing into a worker lane', lane.decision?.kind === 'deny' && lane.decision.reason.includes('worker lane'), lane.decision?.reason)
	const laneRelative = await gate({ agent: MAIN, name: 'edit', arguments: { file_path: '.worktrees/login/app.js' } })
	check('the lane test covers relative paths as well', laneRelative.decision?.kind === 'deny')
	const laneDir = await gate({ agent: MAIN, name: 'write', arguments: { file_path: '.worktrees' } })
	check('the lane directory itself is denied', laneDir.decision?.kind === 'deny')
	const lookalike = await gate({ agent: MAIN, name: 'write', arguments: { file_path: 'worktrees/login/app.js' } })
	check('a directory merely named like the lane passes', lookalike.nextCalled, lookalike.decision?.reason)
	const otherPathKey = await gate({ agent: MAIN, name: 'write', arguments: { path: '.worktrees/login/app.js' } })
	check('the other file-path argument name is honoured', otherPathKey.decision?.kind === 'deny')
	const noPath = await gate({ agent: MAIN, name: 'write', arguments: {} })
	check('a write the gate cannot read passes (fail open)', noPath.nextCalled)
}

// --- gate: shell ----------------------------------------------------------------

{
	const push = await gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'git -c user.name=x push origin main' } })
	check('gate denies git push', push.decision?.kind === 'deny' && push.decision.reason.includes('outside the repository'), push.decision?.reason)
	const publish = await gate({ agent: MAIN, name: 'bash', arguments: { command: 'npm publish --access public' } })
	check('gate denies package publishing', publish.decision?.kind === 'deny')
	const gh = await gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'gh pr create --title x' } })
	check('gate denies a github write (gh pr)', gh.decision?.kind === 'deny')
	const ghRead = await gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'gh run view 12345' } })
	check('a gh read passes', ghRead.nextCalled, ghRead.decision?.reason)
	const laneWipe = await gate({ agent: MAIN, name: 'bash', arguments: { command: 'rm -rf .worktrees/login' } })
	check('gate denies destroying a work area from the shell', laneWipe.decision?.kind === 'deny', laneWipe.decision?.reason)
	const laneRead = await gate({ agent: MAIN, name: 'pwsh', arguments: { command: 'Get-ChildItem .worktrees | Select-Object Name' } })
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
		const r = await gate({ agent: MAIN, name: 'pwsh', arguments: { command } })
		check(`in-repo work passes (${label})`, r.nextCalled, r.decision?.reason)
	}
	const read = await gate({ agent: MAIN, name: 'bash', arguments: { command: 'git status && git log -n 3 && git branch' } })
	check('gate passes git status/log/branch-list', read.nextCalled)
	const mergeTool = await gate({ agent: MAIN, name: 'orch_tool', arguments: { action: 'merge', feature_id: 'login' } })
	check('gate passes the integration tool', mergeTool.nextCalled)
}

// --- gate: dispatch is opt-in ----------------------------------------------------

{
	const featurePrompt = (body) =>
		'You are the login feature agent.\nFirst call the skill tool with name orch-lite-executor and follow it.\n' +
		'```json\n' + JSON.stringify(body) + '\n```'
	const good = featurePrompt({ feature_id: 'login', objective: 'o', acceptance_criteria: ['c'], worktree: join(root, '.worktrees', 'login') })
	check('gate passes a compliant feature package', (await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: good } })).nextCalled)
	check(
		'gate accepts free-form description (no longer bound to feature_id)',
		(await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'Login feature', prompt: good } })).nextCalled,
	)
	check(
		'gate rejects a missing handbook pointer',
		(await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: featurePrompt({ feature_id: 'login', objective: 'o', acceptance_criteria: ['c'], worktree: join(root, '.worktrees', 'login') }).replace('orch-lite-executor', 'other') } })).decision?.reason.includes('handbook'),
	)
	const noWorktree = featurePrompt({ feature_id: 'login', objective: 'o', acceptance_criteria: ['c'] })
	const missingArea = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: noWorktree } })
	check('a feature package without a work area is refused (S2)', missingArea.decision?.kind === 'deny' && missingArea.decision.reason.includes('worktree'), missingArea.decision?.reason)
	const missingField = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: featurePrompt({ feature_id: 'login', objective: 'o' }) } })
	check('a feature package missing acceptance_criteria is refused', missingField.decision?.kind === 'deny')
	const badId = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'Login', prompt: featurePrompt({ feature_id: 'Login', objective: 'o', acceptance_criteria: ['c'], worktree: join(root, '.worktrees', 'login') }) } })
	check('a non-kebab feature_id is refused', badId.decision?.kind === 'deny')
	const prose = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'summarize notes', prompt: 'Read memory/session.md and append today’s decisions. No structured package here.' } })
	check('a dispatch that is not a feature package passes (opt-in contract)', prose.nextCalled, prose.decision?.reason)
	const otherSkill = await gate({ agent: MAIN, name: 'subagent_fork', arguments: { description: 'remember', prompt: 'Load the memory skill and store this preference in the memory file.' } })
	check("another skill's own dispatch convention passes", otherSkill.nextCalled, otherSkill.decision?.reason)
	const bareMention = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: 'feature_id: login — but no fenced package and no handbook pointer' } })
	check('prose that merely mentions feature_id passes unvalidated (narrowed trigger)', bareMention.nextCalled, bareMention.decision?.reason)
	const handbookNoPkg = await gate({ agent: MAIN, name: 'subagent', arguments: { description: 'login', prompt: 'First call the skill tool with name orch-lite-executor and follow it.\nWrite the fix. No fenced package at all.' } })
	check('claiming the handbook without a package is told why', handbookNoPkg.decision?.kind === 'deny' && handbookNoPkg.decision.reason.includes('package'), handbookNoPkg.decision?.reason)
	// M9 removed: explore carries no contract the gate could police.
	const looseExplore = await gate({ agent: MAIN, name: 'explore', arguments: { description: 'trace-auth', prompt: 'Find every token validation site and report with file:line.' } })
	check('explore is no longer package-gated', looseExplore.nextCalled, looseExplore.decision?.reason)
}

// --- gate: children are not routed ------------------------------------------------

{
	const w = await gate({ agent: CHILD, name: 'write', arguments: { file_path: '.worktrees/login/app.js', content: 'y' } })
	check('a worker writes inside its own area', w.nextCalled)
	const d = await gate({ agent: CHILD, name: 'subagent', arguments: { description: 'x', prompt: 'whatever' } })
	check('a worker dispatch is left to the platform depth setting', d.nextCalled, d.decision?.reason)
	const t = await gate({ agent: CHILD, name: 'spawn_teammate', arguments: {} })
	check('the plugin does not re-implement the Lead-only rule', t.nextCalled)
	const p = await gate({ agent: CHILD, name: 'workflow', arguments: {} })
	check('the plugin does not gate workflow either', p.nextCalled)
}

// --- gate: unknown agents pass ------------------------------------------------------

{
	check('host-local calls (no agent) pass', (await gate({ name: 'write', arguments: {} })).nextCalled)
	const foreign = { session: { header: { id: 'f', cwd: root, agentPreset: 'standard' } } }
	check('foreign-preset sessions pass untouched', (await gate({ agent: foreign, name: 'write', arguments: { file_path: '.worktrees/login/x' } })).nextCalled)
	// The live preset is the `agentPreset` Session projection, not the creation
	// header: a session that switched INTO orch-lite during its blank window is
	// gated even though its header still says standard, and a session that
	// switched away is released even though its header still says orch-lite.
	ctx.sessionProjections = { stateOf: () => 'orch-lite' }
	check(
		'a switch into orch-lite is gated despite a stale header',
		(await gate({ agent: foreign, name: 'write', arguments: { file_path: join(root, '.worktrees', 'login', 'x') } })).decision?.kind === 'deny',
	)
	ctx.sessionProjections = { stateOf: () => 'standard' }
	check(
		'a switch away from orch-lite releases the gate',
		(await gate({ agent: MAIN, name: 'write', arguments: { file_path: join(root, '.worktrees', 'login', 'x') } })).nextCalled,
	)
	ctx.sessionProjections = undefined
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

// --- allocation reports what the fresh area will NOT contain --------------------
// A new area is HEAD: the primary tree's uncommitted files are simply not in
// it, and the worker discovering that mid-task is a surprise worth one line
// at allocation time.
writeFileSync(join(root, 'uncommitted-note.txt'), 'wip\n', 'utf8')
const withNotice = await callTool('create', { feature_id: 'noted' })
check(
	'create reports the primary tree uncommitted files',
	Array.isArray(withNotice.primary_tree_dirty) && withNotice.primary_tree_dirty.includes('uncommitted-note.txt'),
	JSON.stringify(withNotice.primary_tree_dirty),
)
check('the render carries the heads-up', registered.get('orch_tool').output.render({}, withNotice)[0].text.includes('Heads-up'))
check('the dispatch hint passes the area as the child cwd', registered.get('orch_tool').output.render({}, withNotice)[0].text.includes('cwd'))
rmSync(join(root, 'uncommitted-note.txt'))
// retire the probe area: a never-committed area left behind reads as stale once main moves
await callTool('remove', { feature_id: 'noted' })

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
// merge must never bootstrap: it fails, and leaves no repository behind
await rejects('merge refuses a non-repository workspace', () => registered.get('orch_tool').execute({ action: 'merge', feature_id: 'x' }, bareExec))
check('the merge attempt created no repository', !existsSync(join(bare, '.git')))
// an EMPTY folder is bootstrapped: that is the fresh-workspace case
const bootstrapped = await registered.get('orch_tool').execute({ action: 'create', feature_id: 'scratch' }, bareExec)
check('create bootstraps a repository in an empty folder', bootstrapped.created === true && bootstrapped.branch === 'feature/scratch', JSON.stringify(bootstrapped))
check('the repository now exists', existsSync(join(bare, '.git')))
check('the feature work area is on disk', existsSync(join(bare, '.worktrees', 'scratch')))
check('the bootstrap notice reaches the model through the tool result', typeof bootstrapped.note === 'string' && bootstrapped.note.includes('Bootstrapped a git repository'), String(bootstrapped.note))
check('the notice renders ahead of the dispatch hint', registered.get('orch_tool').output.render({}, bootstrapped)[0].text.includes('Bootstrapped a git repository'))
const bareLog = (await git(['log', '--format=%s'], bare)).trim()
check('a baseline commit exists', bareLog.includes('chore: orch-lite baseline'), bareLog)
check('ignored entries were written', readFileSync(join(bare, '.gitignore'), 'utf8').includes('.worktrees/'))

// --- a folder that already holds user files is NOT adopted -------------------------
//
// A scattered `.git` in a user's folder is not something a local git command can
// undo, so the bootstrap refuses a directory that is not empty and says so.

const occupied = mkdtempSync(join(tmpdir(), 'orch-occupied-'))
const occupiedExec = { signal: new AbortController().signal, agent: { session: { header: { cwd: occupied, id: 'occupied' } } } }
writeFileSync(join(occupied, 'notes.txt'), 'user content\n', 'utf8')
const refusedBootstrap = await registered.get('orch_tool').execute({ action: 'create', feature_id: 'scratch' }, occupiedExec)
check('create refuses to adopt a folder that holds user files', refusedBootstrap.created !== true, JSON.stringify(refusedBootstrap))
check('the refused folder has no repository', !existsSync(join(occupied, '.git')))
check('the refusal notice reaches the model through the tool result', typeof refusedBootstrap.note === 'string' && refusedBootstrap.note.includes('Refused to bootstrap'), String(refusedBootstrap.note))
check('the user file is untouched', readFileSync(join(occupied, 'notes.txt'), 'utf8').includes('user content'))

// --- list: the observable state of work areas -------------------------------

await callTool('remove', { feature_id: 'login' })
const listed = await callTool('list', {})
check('list reports the live docs area', listed.areas.some(a => a.feature_id === 'docs' && a.branch === 'feature/docs'), JSON.stringify(listed.areas))
check('list reports the path of each area', listed.areas.every(a => a.path.includes('.worktrees')), JSON.stringify(listed.areas.map(a => a.path)))
check('list names feature branches with no active area', listed.branches.includes('feature/login') && listed.branches.includes('feature/rival'), JSON.stringify(listed.branches))
check('list is read-only: no repository was touched for it', existsSync(join(root, '.worktrees', 'login', 'dirty.txt')) === false)

// --- doctor: the isolation-model hygiene scan -------------------------------

// The docs area holds unmerged work — it must not be reported as stale.
writeFileSync(join(root, '.worktrees', 'docs', 'in-progress.txt'), 'wip', 'utf8')
await git(['-C', join(root, '.worktrees', 'docs'), 'add', '.'])
await git(['-C', join(root, '.worktrees', 'docs'), '-c', 'user.name=docs', '-c', 'user.email=docs@orch-lite.local', 'commit', '-qm', 'feat: docs work in progress'])

const doc = await callTool('doctor', {})
check('doctor reports the integration branch', doc.integration_branch === 'main', doc.integration_branch)
check('doctor finds no dirty areas', doc.dirty.length === 0, JSON.stringify(doc.dirty))
check('doctor finds no stale areas', doc.stale.length === 0, JSON.stringify(doc.stale))
check('doctor finds no bypassed commits', doc.bypassed.length === 0, JSON.stringify(doc.bypassed))

// doctor's two failure modes, in turn:
// 1. a dirty area
writeFileSync(join(root, '.worktrees', 'docs', 'uncommitted.txt'), 'x', 'utf8')
const docDirty = await callTool('doctor', {})
check('doctor reports a dirty area', docDirty.dirty.some(d => d.branch === 'feature/docs' && d.files.includes('uncommitted.txt')), JSON.stringify(docDirty.dirty))
rmSync(join(root, '.worktrees', 'docs', 'uncommitted.txt'))

// 2. a feature_id commit that landed directly on the integration branch
await git(['checkout', 'main', '-q'])
await writeFileSync(join(root, 'bypassed.txt'), 'y', 'utf8')
await git(['add', '.'])
await git(['-c', 'user.name=login', '-c', 'user.email=login@orch-lite.local', 'commit', '-qm', 'login: direct commit on main'])
const docBypassed = await callTool('doctor', {})
check('doctor reports a feature_id commit on the integration branch', docBypassed.bypassed.some(b => b.author === 'login' && b.subject.includes('direct commit on main')), JSON.stringify(docBypassed.bypassed))
await git(['reset', '--hard', 'HEAD~1', '-q'])

// 3. a stale area: a feature whose branch is already merged still holds its area
await callTool('create', { feature_id: 'stale-demo' })
writeFileSync(join(root, '.worktrees', 'stale-demo', 'stale.txt'), 'z', 'utf8')
await git(['-C', join(root, '.worktrees', 'stale-demo'), 'add', '.'])
await git(['-C', join(root, '.worktrees', 'stale-demo'), '-c', 'user.name=stale-demo', '-c', 'user.email=stale-demo@orch-lite.local', 'commit', '-qm', 'feat: stale demo'])
await git(['merge', '--no-edit', 'feature/stale-demo', '-q'])
const docStale = await callTool('doctor', {})
check('doctor reports a work area whose branch is already merged', docStale.stale.some(s => s.branch === 'feature/stale-demo'), JSON.stringify(docStale.stale))
check('a merged feature is not a bypass', docStale.bypassed.every(b => b.author !== 'stale-demo'), JSON.stringify(docStale.bypassed))

// --- the read-only actions need no repository and never bootstrap -----------

const bareList = mkdtempSync(join(tmpdir(), 'orch-norepo-list-'))
const bareListExec = { signal: new AbortController().signal, agent: { session: { header: { cwd: bareList, id: 'no-repo-list' } } } }
await rejects('list refuses a non-repository workspace', () => registered.get('orch_tool').execute({ action: 'list', feature_id: 'x' }, bareListExec))
await rejects('doctor refuses a non-repository workspace', () => registered.get('orch_tool').execute({ action: 'doctor', feature_id: 'x' }, bareListExec))
check('the read-only actions created no repository', !existsSync(join(bareList, '.git')))

rmSync(root, { recursive: true, force: true })
rmSync(bare, { recursive: true, force: true })
rmSync(bareList, { recursive: true, force: true })

console.log(`\n${passed}/${passed + failed} passed`)
if (warnings.length > 0) console.log(`warnings: ${warnings.join(' | ')}`)
process.exit(failed === 0 ? 0 : 1)
