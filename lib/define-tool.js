/**
 * A local `defineTool`, compatible with the Host's `@deepseek-ai/dsh-tools`
 * version for everything this bundle uses: the compact schema DSL becomes JSON
 * Schema, arguments are validated against it before `execute` runs, and the
 * result is the object shape `ctx.tools.register` expects.
 *
 * It cannot be imported — `@deepseek-ai/*` lives inside app.asar, unreachable
 * from a profile `link:` plugin. See DEVLOG.md.
 */

/** Keys the schema DSL passes through to the compiled JSON Schema node. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

/** Argument rejection, carrying the same code the Host raises. */
export class ToolArgsError extends Error {
	/**
	 * @param {string[]} violations
	 */
	constructor(violations) {
		super(`invalid arguments: ${violations.join('; ')}`)
		this.name = 'ToolArgsError'
		this.code = 'INVALID_ARGS'
		this.violations = violations
	}
}

/**
 * @param {object} source compact schema node
 * @param {object} target compiled JSON Schema node
 */
function copyAnnotations(source, target) {
	for (const key of ANNOTATION_KEYS) {
		if (Object.hasOwn(source, key)) target[key] = source[key]
	}
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSchemaRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {object} input
 * @returns {string}
 */
function authorError(input) {
	throw new Error(input)
}

/**
 * Compile one compact value schema into JSON Schema.
 *
 * @param {object} spec compact value schema
 * @param {string} path diagnostic path
 * @returns {object}
 */
function compileValueSchema(spec, path) {
	if (!isSchemaRecord(spec)) authorError(`${path} must be a value schema object`)
	const node = {}

	if (Object.hasOwn(spec, 'oneOf')) {
		if (Object.hasOwn(spec, 'type')) authorError(`${path} cannot declare both type and oneOf`)
		if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) {
			authorError(`${path}.oneOf must be an array of at least two value schemas`)
		}
		node.oneOf = spec.oneOf.map((branch, index) => compileValueSchema(branch, `${path}.oneOf[${index}]`))
		copyAnnotations(spec, node)
		return node
	}

	switch (spec.type) {
		case 'json':
			// Deliberately unconstrained: any JSON value passes.
			copyAnnotations(spec, node)
			return node
		case 'object': {
			if (typeof spec.additionalProperties !== 'boolean') {
				authorError(`${path}.additionalProperties must be explicitly true or false`)
			}
			node.type = 'object'
			copyAnnotations(spec, node)
			node.additionalProperties = spec.additionalProperties
			if (Object.hasOwn(spec, 'properties')) {
				const compiled = compilePropertyMap(spec.properties, `${path}.properties`)
				node.properties = compiled.properties
				if (compiled.required.length > 0) node.required = compiled.required
			}
			return node
		}
		case 'array':
			if (!Object.hasOwn(spec, 'items')) authorError(`${path}.items is required`)
			node.type = 'array'
			copyAnnotations(spec, node)
			node.items = compileValueSchema(spec.items, `${path}.items`)
			return node
		case 'string':
		case 'number':
		case 'integer':
		case 'boolean':
		case 'null':
			node.type = spec.type
			copyAnnotations(spec, node)
			if (Object.hasOwn(spec, 'enum')) {
				if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
					authorError(`${path}.enum must be a non-empty array of scalar values`)
				}
				node.enum = [...spec.enum]
			}
			if (Object.hasOwn(spec, 'const')) node.const = spec.const
			return node
		default:
			authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
	}
}

/**
 * Compile the compact `{ name: spec }` parameter map into JSON Schema properties
 * plus the required-key list.
 *
 * @param {object} input
 * @param {string} path
 * @returns {{properties: object, required: string[]}}
 */
function compilePropertyMap(input, path) {
	if (!isSchemaRecord(input)) authorError(`${path} must be an object of value schemas`)
	const properties = {}
	const required = []
	for (const [key, property] of Object.entries(input)) {
		if (!isSchemaRecord(property)) authorError(`${path}.${key} must be a value schema object`)
		if (Object.hasOwn(property, 'required')) {
			if (property.required !== true) authorError(`${path}.${key}.required must be true when present`)
			required.push(key)
		}
		properties[key] = compileValueSchema(property, `${path}.${key}`)
	}
	return { properties, required }
}

/**
 * @param {object} spec compact parameter map
 * @returns {object} JSON Schema
 */
function parametersToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, 'parameters')
	return {
		type: 'object',
		properties: compiled.properties,
		...(compiled.required.length === 0 ? {} : { required: compiled.required }),
	}
}

/**
 * Validate a value against a compiled schema.
 *
 * @param {object} schema compiled JSON Schema node
 * @param {unknown} value
 * @param {string} path diagnostic path; '' at the root
 * @returns {string[]} violations in schema-walk order
 */
function violationsFor(schema, value, path) {
	if (schema.oneOf !== undefined) {
		const matched = schema.oneOf.some(branch => violationsFor(branch, value, path).length === 0)
		return matched ? [] : [`${path === '' ? 'value' : path} did not match any allowed schema`]
	}

	const violations = []
	switch (schema.type) {
		case undefined:
			// `json`: anything goes.
			return violations
		case 'string':
			if (typeof value !== 'string') return [`${path} must be a string`]
			break
		case 'boolean':
			if (typeof value !== 'boolean') return [`${path} must be a boolean`]
			break
		case 'integer':
			if (typeof value !== 'number' || !Number.isInteger(value)) return [`${path} must be an integer`]
			break
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} must be a number`]
			break
		case 'null':
			if (value !== null) return [`${path} must be null`]
			break
		case 'array': {
			if (!Array.isArray(value)) return [`${path} must be an array`]
			value.forEach((item, index) => violations.push(...violationsFor(schema.items, item, `${path}[${index}]`)))
			return violations
		}
		case 'object': {
			if (!isSchemaRecord(value)) return [`${path} must be an object`]
			const child = key => (path === '' ? key : `${path}.${key}`)
			for (const key of schema.required ?? []) {
				if (!Object.hasOwn(value, key)) violations.push(`${child(key)} is required`)
			}
			for (const [key, property] of Object.entries(schema.properties ?? {})) {
				if (Object.hasOwn(value, key)) violations.push(...violationsFor(property, value[key], child(key)))
			}
			if (schema.additionalProperties === false) {
				const allowed = new Set(Object.keys(schema.properties ?? {}))
				for (const key of Object.keys(value)) {
					if (!allowed.has(key)) violations.push(`${child(key)} is not an allowed property`)
				}
			}
			return violations
		}
		default:
			return violations
	}

	if (Object.hasOwn(schema, 'const') && value !== schema.const) {
		violations.push(`${path} must be ${JSON.stringify(schema.const)}`)
	}
	if (schema.enum !== undefined && !schema.enum.includes(value)) {
		violations.push(`${path} must be one of ${schema.enum.map(entry => JSON.stringify(entry)).join(', ')}`)
	}
	return violations
}

/**
 * Define one tool.
 *
 * @param {object} options
 * @returns {object} the normalized tool definition `ctx.tools.register` accepts
 */
export function defineTool(options) {
	const { name, description, execute: userExecute, output } = options
	const userRender = output.render

	if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
		throw new Error(`defineTool(${name}): timeoutMs must be a positive finite number`)
	}

	const parameters = parametersToJsonSchema(options.parameters)
	const outputSchema = compileValueSchema(output.schema, 'schema')

	return {
		name,
		description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value)
			},
		},
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		async execute(args, exec) {
			const violations = violationsFor(parameters, args, '')
			if (violations.length > 0) throw new ToolArgsError(violations)
			return userExecute(args, exec)
		},
	}
}