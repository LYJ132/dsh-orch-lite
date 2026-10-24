/**
 * Client half of dsh-orch-lite: a composer banner that names the two profile
 * bundles which silently compete with this preset, and offers the one action
 * that stops each.
 *
 * Why a client half at all: the Node half cannot see profile composition
 * decisions. `pluginManager` owns the profile's bundle layer selection, and the
 * page is the owner peer, so the honest place for "these two bundles are on and
 * they change what your agents do" is where the user is working. The banner is
 * mounted in `conversation.input.dock` (session-scoped list slot, above the
 * composer) because it reads as a session-start note, and it renders nothing
 * when neither bundle is enabled — no permanent chrome.
 *
 * Hard constraints (see DEVLOG.md § v1.1.11):
 * - no `@deepseek-ai/dsh-client-ui-*` import: this module requires only `react`,
 *   which the browser kernel provides;
 * - the module registers exactly one slot entry, through
 *   `ctx.slots.inject(ownerKey, () => ctx.slots.register({ ... }, Component))`;
 * - the action is the profile's own `setBundleEnabled`, never a tool call and
 *   never a hand-edited package.json / cordis.patch.yml;
 * - re-enabling is never automatic, because enabling a bundle appends it to the
 *   end of the profile bundle list and changes patch precedence.
 *
 * Package: dsh-orch-lite. Decision history: see DEVLOG.md.
 */

window.__ModuleLoader__.load({
	id: 'dsh-orch-lite',
	factory(require) {
		const react = require('react')

		/** The profile bundles this preset competes with, and the action that stops each. */
		const CONFLICTS = [
			{
				bundle: '@deepseek-ai/dsh-experimental-agent-team-profile',
				short: 'Team',
				action: 'Turn Team off',
				conflict:
					'The Agent Team profile disables the child-control tools (tool-subagent-control, tool-subagent-list-agents, tool-subagent, tool-subagent-fork), so a running dispatched child reads as idle.',
				effect:
					"Turning Team off removes that bundle's disabled:true overrides and restores tool-subagent-control, tool-subagent-list-agents, tool-subagent and tool-subagent-fork — the tools child listing and continuation need.",
			},
			{
				bundle: '@deepseek-ai/dsh-experimental-tool-worktree',
				short: 'Git Worktrees',
				action: 'Turn Git Worktrees off',
				conflict:
					"The Git Worktrees bundle adds a create-only create_worktree tool; its create path moves the session's own working directory, competing with this preset's work areas.",
				effect:
					'Turning Git Worktrees off leaves orch_tool as the only work-area tool — create, merge, remove, list and doctor — and no tool moves the working directory.',
			},
		]

		/** Why the banner never offers the opposite action. */
		const REENABLE_NOTE =
			'Re-enabling is never automatic: enabling a bundle appends it to the end of the profile bundle list and changes patch precedence, so switch it back on from Plugins yourself.'

		const TITLE = 'orch-lite: this profile mounts bundles that compete with the preset'

		// Colour tokens only from the shared alias set; spacing and radii are
		// plain numbers so this bundle needs no stylesheet of its own.
		const STYLES = {
			section: {
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				margin: '0 0 8px',
				padding: '10px 12px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: '10px',
				background: 'var(--dsw-alias-bg-module-platform)',
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '12px',
				lineHeight: '18px',
			},
			title: {
				margin: '0',
				color: 'var(--dsw-alias-label-secondary)',
				fontWeight: '500',
				fontSize: '12px',
				lineHeight: '18px',
			},
			row: {
				display: 'flex',
				alignItems: 'flex-start',
				gap: '8px',
			},
			text: {
				display: 'flex',
				flexDirection: 'column',
				flex: '1 1 auto',
				gap: '2px',
				minWidth: '0',
			},
			line: {
				margin: '0',
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '12px',
				lineHeight: '18px',
			},
			detail: {
				margin: '0',
				color: 'var(--dsw-alias-label-tertiary)',
				fontSize: '12px',
				lineHeight: '18px',
			},
			outcome: {
				margin: '0',
				color: 'var(--dsw-alias-label-secondary)',
				fontSize: '12px',
				lineHeight: '18px',
			},
			outcomeFailed: {
				margin: '0',
				color: 'var(--dsw-alias-state-error-primary)',
				fontSize: '12px',
				lineHeight: '18px',
			},
			button: {
				flex: '0 0 auto',
				padding: '4px 10px',
				border: '1px solid var(--dsw-alias-border-l3)',
				borderRadius: '8px',
				background: 'var(--dsw-alias-bg-base)',
				color: 'var(--dsw-alias-label-primary)',
				font: 'inherit',
				fontSize: '12px',
				lineHeight: '18px',
				cursor: 'pointer',
			},
		}

		/**
		 * Unwrap one remote answer.
		 *
		 * The page's remote namespaces answer `{ ok: true, value }` or
		 * `{ ok: false, error }`; a release that answers the value directly is
		 * accepted too, so the banner reports the Host rather than assuming a
		 * shape. A refusal is a value, not an exception: render it.
		 *
		 * @param {unknown} answer whatever the remote call resolved to
		 * @returns {{ok: boolean, value?: unknown, error?: unknown}}
		 */
		function unwrap(answer) {
			if (answer !== null && typeof answer === 'object' && typeof answer.ok === 'boolean') {
				return answer.ok ? { ok: true, value: answer.value } : { ok: false, error: answer.error }
			}
			return { ok: true, value: answer }
		}

		/**
		 * Turn a `listBundles` answer into the set of enabled package names.
		 *
		 * @param {unknown} answer the remote answer
		 * @returns {Set<string>|undefined} undefined when the read failed — the
		 *   banner then keeps its previous state instead of guessing
		 */
		function enabledBundles(answer) {
			const result = unwrap(answer)
			if (!result.ok || !Array.isArray(result.value)) return undefined
			const names = new Set()
			for (const bundle of result.value) {
				if (bundle !== null && typeof bundle === 'object' && bundle.enabled === true && typeof bundle.name === 'string') {
					names.add(bundle.name)
				}
			}
			return names
		}

		/**
		 * The text for one Host error, never empty and never "undefined".
		 *
		 * @param {unknown} error the `error` field of a failed answer or result
		 * @returns {string}
		 */
		function errorText(error) {
			if (typeof error === 'string' && error !== '') return error
			if (error !== null && typeof error === 'object') {
				for (const key of ['message', 'diagnostic', 'code']) {
					const value = error[key]
					if (typeof value === 'string' && value !== '') return value
				}
			}
			return 'the Host reported no further detail'
		}

		/**
		 * Render one application outcome, naming the state the Host returned.
		 *
		 * The state token is kept verbatim (`applied`, `restart-required`,
		 * `overridden`, `failed`, `cancelled`) because it is the only fact the
		 * user can check against the profile files.
		 *
		 * @param {{short: string}} conflict the conflict the click addressed
		 * @param {object} outcome `{ busy }` while in flight, else `{ application, restartReason?, error? }`
		 * @returns {string}
		 */
		function outcomeText(conflict, outcome) {
			const prefix = `${conflict.short} off: `
			if (outcome.busy === true) return `${prefix}working…`
			switch (outcome.application) {
				case 'applied':
					return `${prefix}applied.`
				case 'restart-required':
					return `${prefix}restart-required — saved, and the Host applies it after a restart${outcome.restartReason === undefined ? '' : ` (${outcome.restartReason})`}.`
				case 'overridden':
					return `${prefix}overridden — a higher-priority profile layer still enables the bundle.`
				case 'cancelled':
					return `${prefix}cancelled — nothing changed.`
				default:
					return `${prefix}failed — ${errorText(outcome.error)}`
			}
		}

		/**
		 * The banner. Renders nothing until the bundle list has been read, and
		 * then only while one of the two conflicting bundles is still enabled or
		 * an outcome from this session is still worth showing.
		 *
		 * @param {{pluginManager: {listBundles: Function, setBundleEnabled: Function, subscribe: Function}}} props
		 *   the face resolved by the slot registration's `inject`
		 */
		function ConflictGuard(props) {
			const pluginManager = props.pluginManager
			const [enabled, setEnabled] = react.useState(undefined)
			const [outcomes, setOutcomes] = react.useState({})

			react.useEffect(() => {
				let live = true
				const refresh = () => {
					pluginManager.listBundles().then(
						answer => {
							if (!live) return
							const names = enabledBundles(answer)
							if (names === undefined) return
							setEnabled(names)
							// An "applied" note is stale as soon as the bundle is on
							// again (the user may have switched it back on in Plugins);
							// a failure may describe an attempt worth keeping visible.
							setOutcomes(current => {
								const next = {}
								for (const [bundle, outcome] of Object.entries(current)) {
									if (outcome.application === 'applied' && names.has(bundle)) continue
									next[bundle] = outcome
								}
								return Object.keys(next).length === Object.keys(current).length ? current : next
							})
						},
						() => {
							// A read that never answered is not evidence that the
							// profile is clean; keep the last known state.
						},
					)
				}
				refresh()
				const off = typeof pluginManager.subscribe === 'function' ? pluginManager.subscribe(refresh) : undefined
				return () => {
					live = false
					if (typeof off === 'function') off()
				}
			}, [])

			const turnOff = conflict => {
				setOutcomes(current => ({ ...current, [conflict.bundle]: { busy: true } }))
				pluginManager.setBundleEnabled(conflict.bundle, false).then(
					answer => {
						const result = unwrap(answer)
						if (!result.ok) {
							setOutcomes(current => ({ ...current, [conflict.bundle]: { application: 'failed', error: result.error } }))
							return
						}
						const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
						setOutcomes(current => ({
							...current,
							[conflict.bundle]: {
								application: typeof value.application === 'string' ? value.application : 'failed',
								restartReason: value.restartReason,
								error: value.error,
							},
						}))
					},
					error => {
						setOutcomes(current => ({
							...current,
							[conflict.bundle]: { application: 'failed', error: { message: errorText(error) } },
						}))
					},
				)
			}

			const visible = CONFLICTS.filter(
				conflict => (enabled !== undefined && enabled.has(conflict.bundle)) || outcomes[conflict.bundle] !== undefined,
			)
			if (visible.length === 0) return null

			return react.createElement(
				'section',
				{ style: STYLES.section, 'aria-label': 'orch-lite bundle conflicts' },
				react.createElement('p', { style: STYLES.title }, TITLE),
				...visible.map(conflict => {
					const outcome = outcomes[conflict.bundle]
					const isEnabled = enabled !== undefined && enabled.has(conflict.bundle)
					return react.createElement(
						'div',
						{ key: conflict.bundle, style: STYLES.row },
						react.createElement(
							'div',
							{ style: STYLES.text },
							react.createElement('p', { style: STYLES.line }, conflict.conflict),
							react.createElement('p', { style: STYLES.detail }, conflict.effect),
							outcome === undefined
								? null
								: react.createElement(
										'p',
										{
											style: outcome.application === 'failed' ? STYLES.outcomeFailed : STYLES.outcome,
											'aria-live': 'polite',
										},
										outcomeText(conflict, outcome),
									),
						),
						isEnabled
							? react.createElement(
									'button',
									{
										type: 'button',
										style: STYLES.button,
										disabled: outcome !== undefined && outcome.busy === true,
										onClick: () => turnOff(conflict),
									},
									conflict.action,
								)
							: null,
					)
				}),
				react.createElement('p', { style: STYLES.detail }, REENABLE_NOTE),
			)
		}

		/**
		 * Cordis services this browser half needs. `remote.pluginManager` is the
		 * profile's bundle manager; it implies `remote`, whose `$on` carries the
		 * `plugin-manager/changed` invalidation.
		 */
		const inject = ['slots', 'remote.pluginManager']

		/**
		 * Mount the one slot entry.
		 *
		 * @param {object} ctx the browser plugin context
		 */
		function apply(ctx) {
			const pluginManager = {
				listBundles: () => ctx.remote.pluginManager.listBundles(),
				setBundleEnabled: (packageName, enabledBundle) => ctx.remote.pluginManager.setBundleEnabled(packageName, enabledBundle),
				subscribe: listener => ctx.remote.$on('plugin-manager/changed', listener),
			}
			ctx.slots.inject('conversation.input.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.dock',
						id: 'orch-lite-bundle-guard',
						order: 30,
						inject: () => ({ pluginManager }),
					},
					ConflictGuard,
				),
			)
		}

		return { inject, apply }
	},
})
