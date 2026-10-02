/**
 * Host-plugin half of the bundle: publish the two orch-lite manuals as runtime
 * skills in the GLOBAL layer, so **every** preset can load them.
 *
 * The rest of the bundle (the three worktree tools, the gate, the protocol
 * section, the boot injection) is a preset-row plugin and stays scoped to the
 * `orch-lite` preset. Knowledge is shared; capability is not: a session outside
 * the preset can read the manual but has no worktree tools and nothing
 * enforcing the discipline.
 *
 * Why a separate host row instead of the preset row: `skill-filesystem` does
 * not scan plugin directories, and a runtime registration is filed into the
 * layer of its calling context. A host row's registrations land in the global
 * layer, which every session's catalog merges in; the preset row's land in that
 * preset's layer only.
 *
 * Package: dsh-orch-lite. Decision history: see DEVLOG.md.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

/** This package's root directory — bundled assets resolve from here. */
const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** The bundled manuals, as paths relative to the package root. */
const SKILLS = ['skills/orch-lite/SKILL.md', 'skills/orch-lite-executor/SKILL.md']

export const name = 'orch-lite-skills'
export const inject = ['skills']

/**
 * Read one bundled SKILL.md and split frontmatter from body.
 *
 * @param {string} relative path from the package root
 * @returns {{name: string|undefined, description: string, content: string}}
 */
export function readSkill(relative) {
	const raw = readFileSync(join(PKG_DIR, relative), 'utf8')
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
	if (match === null || match === undefined) return { name: undefined, description: '', content: raw }
	const fields = {}
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/)
		if (kv !== null && kv !== undefined) fields[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1')
	}
	return { name: fields.name, description: fields.description ?? '', content: raw.slice(match[0].length).replace(/^\r?\n+/, '') }
}

/**
 * Register both manuals into the global skill layer.
 *
 * @param {object} ctx
 */
export function apply(ctx) {
	for (const relative of SKILLS) {
		try {
			const skill = readSkill(relative)
			if (typeof skill.name !== 'string') throw new Error('missing frontmatter name')
			ctx.skills.register({
				name: skill.name,
				description: skill.description,
				content: skill.content,
				source: 'dsh-orch-lite',
				// Without this the loaded skill renders "resources are managed by
				// provider …" — i.e. the model is told nothing about where the package
				// lives, and any relative reference would be unresolvable. With it,
				// `<skill_resources>` carries "Base directory for this skill: <PKG_DIR>"
				// and relative reads (references, DEVLOG, sources) work without guessing.
				resourceBase: { kind: 'directory', path: PKG_DIR },
			})
		} catch (error) {
			ctx.logger.warn(`orch-lite: skill "${relative}" could not be registered: ${String(error)}`)
		}
	}
}
