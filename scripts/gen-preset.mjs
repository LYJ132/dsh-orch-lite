/**
 * Generate `presets/orch-lite.patch.yml` from the shipped `standard` preset.
 *
 * A preset is an authoritative composition, not an incremental layer: the
 * PresetTree is built from the preset's own `plugins` list, and only *services*
 * (subprocess, fs, tools, systemPrompt) reach the agent through the scope parent
 * chain — host plugin rows do not. So a preset that lists only our own two rows
 * yields an agent with three worktree tools and no fs, no subagent, no skill
 * tool, nothing.
 *
 * The fix is to enumerate standard's composition and add our rows to it. Doing
 * that by hand would be a 300-line transcription, so this script assembles it
 * textually and fails loudly if the anchor it expects is missing.
 *
 * Usage: node scripts/gen-preset.mjs <standard.patch.yml> <out.patch.yml>
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [, , standardPath, outPath] = process.argv
if (standardPath === undefined || outPath === undefined) {
	console.error('usage: node gen-preset.mjs <standard.patch.yml> <out.patch.yml>')
	process.exit(2)
}

const standard = readFileSync(standardPath, 'utf8')
const lines = standard.split(/\r?\n/)

const PLUGINS_ANCHOR = '        plugins:'
const start = lines.indexOf(PLUGINS_ANCHOR)
if (start === -1) throw new Error(`standard preset has no ${JSON.stringify(PLUGINS_ANCHOR)} line`)
// Keep the `plugins:` key itself: `body[0]` is that line and `body[1..]` is the list.
const body = lines.slice(start)

// The list ends where the last `          - id:` row ends; anything after it at
// lower indentation belongs to the document, not to the preset.
let end = body.length
while (end > 0 && body[end - 1].trim() === '') end--
const lastRow = body.slice(0, end).filter(line => /^ {10}- id: /.test(line)).pop()
if (lastRow === undefined) throw new Error('standard preset lists no plugins')

// The `plugin-manager` row ships disabled; it is the last thing standard mounts.
const ANCHOR_ROW = /^ {10}- id: tool-plugin-manager$/
const insertAt = body.findIndex(line => ANCHOR_ROW.test(line))
if (insertAt === -1) throw new Error('expected a `tool-plugin-manager` row to anchor the insertion')

const OURS = [
	'',
	'          # --- dsh-orch-lite ---------------------------------------------',
	'          # This preset row registers the protocol section, the worker hint',
	'          # and the gate, all scoped to this preset.',
	'          # The two manuals and the `orch_tool` work-area tool are registered',
	'          # by the host row at the bottom of this patch. See DEVLOG.md.',
	'          - id: orch',
	"            name: 'dsh-orch-lite'",
	'          # orch-lite lane: one-shot read-only sweeps (foreground by default;',
	'          # run_in_background: true yields a job). See DEVLOG.md.',
	'          - id: tool-subagent-explore',
	"            name: '@deepseek-ai/dsh-tool-subagent'",
	'            config:',
	'              provider: spawn',
	'              toolName: explore',
	'              backgroundMode: one-shot',
	'          # --- end dsh-orch-lite -----------------------------------------',
]

const HEADER = [
	'# Agent preset `orch-lite`: the `standard` composition plus the routing',
	'# discipline and the work-area gate.',
	'#',
	'# Two rows ship in this patch:',
	'#   `preset-orch-lite` — the preset itself (protocol section, worker hint,',
	'#   gate); it exists only for sessions that select it;',
	'#   `orch-lite-host` — a HOST row publishing the two manuals AND the `orch_tool`',
	'#   work-area tool into the GLOBAL layers, so every preset can load the manuals',
	'#   and use the tool while enforcement stays scoped to this preset.',
	'#',
	'# GENERATED from the shipped `standard` preset by `scripts/gen-preset.mjs`.',
	'# A preset is an authoritative composition, not an incremental layer, so the',
	'# whole standard plugin list is repeated verbatim below (see DEVLOG.md).',
	'# Re-run the generator when DSH updates `standard` — this list drifts silently',
	'# otherwise. Row edits saved in the Web editor target `preset-standard` and do',
	'# NOT apply to this preset.',
	'#',
	'# Mounted only when a session selects this preset; `standard` itself is',
	'# untouched for everyone else.',
]

const DESCRIPTION =
	'Coordinates background work — one continuable agent per feature branch, each owning a git work area; wide read-only sweeps run as one-shot explore agents. A gate keeps the main session out of worker lanes and off commands that leave the repository.'

const out = [
	...HEADER,
	'- insert:',
	'    - id: preset-orch-lite',
	"      name: '@deepseek-ai/dsh-agent-preset'",
	'      config:',
	'        id: orch-lite',
	'        name: Orch-lite',
	`        description: ${DESCRIPTION}`,
	'        order: 2',
	...body.slice(0, insertAt),
	...OURS,
	...body.slice(insertAt),
	'    # Host row: the manuals and the `orch_tool` work-area tool are knowledge and',
	'    # capability for every preset; the protocol and the gate above are enforcement',
	'    # for this one only.',
	'    - id: orch-lite-host',
	"      name: 'dsh-orch-lite/host'",
]

writeFileSync(outPath, `${out.join('\n')}\n`, 'utf8')

const added = out.length - lines.length
console.log(`wrote ${outPath}`)
console.log(`  standard rows kept: ${body.filter(line => /^ {10}- id: /.test(line)).length}`)
console.log(`  lines added: ${added}`)