/**
 * Durable audit trail, shared by both halves of the bundle.
 *
 * `ctx.logger` alone is not enough in the desktop build — its `logs` directory
 * stays empty and session logs are zstd-compressed, so a decision would leave
 * no readable trace. Mirrors the harness-home precedence (explicit env, else
 * `~/.dsh`) the same way dsh-home-paths resolves it.
 *
 * Package: dsh-orch-lite. Decision history: see DEVLOG.md.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** `$DSH_HOME/orch-lite/audit.log`, else `~/.dsh/orch-lite/audit.log`. */
export const AUDIT_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'orch-lite', 'audit.log')

/**
 * Append one line to the durable trail. Best-effort: auditing is observability,
 * never enforcement, so every failure is swallowed.
 *
 * @param {string} line
 */
export function appendAudit(line) {
	try {
		mkdirSync(dirname(AUDIT_FILE), { recursive: true })
		appendFileSync(AUDIT_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
	} catch {
		// ignored on purpose
	}
}

/**
 * Log one line to the host logger AND the durable trail.
 *
 * @param {object} ctx
 * @param {string} line
 */
export function note(ctx, line) {
	try {
		ctx.logger.info(line)
	} catch {
		// a strict logger stub must never break a decision
	}
	appendAudit(line)
}
