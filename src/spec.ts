import { FastifyInstance, FastifySchema, RouteOptions } from 'fastify'

interface RouteConfig {
  [key: string]: any
}

export interface Schema {
  [key: string]: any
}

const methodsOrder = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH', 'OPTIONS']

const parametersSections: { [key: string]: string } = {
  headers: 'header',
  params: 'path',
  querystring: 'query'
}

function getRouteConfig(r: RouteOptions): RouteConfig {
  return (r.config as RouteConfig) ?? {}
}

function parseParameters(instance: FastifyInstance, schema: Schema): Schema | undefined {
  const params = []

  // For each parameter section
  for (const [section, where] of Object.entries(parametersSections)) {
    let specs = schema[section]

    // Parameters do not support $ref, so resolve the link
    if (specs?.$ref) {
      specs = instance.getSchema(specs.$ref) as Schema
    }

    // No spec defined, just ignore it
    if (typeof specs !== 'object') {
      continue
    }

    // Get the list of required parameters
    const required: Array<string> = specs.required ?? []

    // For each property
    for (const name of Object.keys(specs.properties ?? {})) {
      params.push({
        name,
        in: where,
        description: specs.description,
        required: required.includes(name)
      })
    }
  }

  if (params.length === 0) {
    return undefined
  }

  return params
}

function parsePayload(schema: Schema): Schema | undefined {
  return {
    description: schema.description,
    content: {
      'application/json': {
        schema: schema
      }
    }
  }
}

function parseResponses(responses: Response): Schema {
  const parsed: Schema = {}

  // For each response code
  for (const [code, originalResponse] of Object.entries(responses)) {
    const { description, $raw, $empty } = originalResponse as { [key: string]: string }
    const spec: Schema = { description }

    // Special handling for raw responses
    if ($raw) {
      spec.content = { [$raw]: {} }
    } else if (!$empty) {
      // Regular response
      spec.content = {
        'application/json': {
          schema: originalResponse
        }
      }
    }

    parsed[code] = spec
  }

  return parsed
}

function cleanSpec(object: Schema): Schema {
  const cleaned: Schema = {}

  // For each pair
  for (const [key, value] of Object.entries(object)) {
    // Strip nulls and undefineds
    if (key === '$id' || value === null || typeof value === 'undefined') {
      continue
    }

    // If it is a reference, replace it
    if (key === '$ref') {
      return { $ref: value.replace('#', '#/components/schemas/') }
    }

    // If is a object
    if (typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into objects
      const cleanedValue = cleanSpec(value)

      // Check if there is a multiple type defined - Replace with anyOf since OpenAPI does not support type arrays
      if (Array.isArray(cleanedValue.type)) {
        cleanedValue.anyOf = cleanedValue.type.map(t => ({ type: t }))
        delete cleanedValue.type
      }

      cleaned[key] = cleanedValue
    } else if (Array.isArray(value)) {
      // Recurse into array
      cleaned[key] = value.map(item => (typeof item === 'object' ? cleanSpec(item) : item))
    } else {
      // Return other properties unchanged
      cleaned[key] = value
    }
  }

  return cleaned
}

export function buildSpec(
  instance: FastifyInstance,
  spec: Schema,
  schemas: { [key: string]: Schema },
  routes: Array<RouteOptions>
): Schema {
  // Prepare the spec
  if (!('components' in spec)) {
    spec.components = {}
  }

  if (!('schemas' in spec.components)) {
    spec.components.schemas = {}
  }

  if (!('paths' in spec)) {
    spec.paths = {}
  }

  // Add all schemas to the components
  for (const [id, definition] of Object.entries(schemas)) {
    spec.components.schemas[id.replace('#', '')] = definition
  }

  // Get the visible routes and sort them
  const apiRoutes = routes.filter(r => getRouteConfig(r).hide !== true).sort((a, b) => a.url.localeCompare(b.url))

  // For each route
  for (const route of apiRoutes) {
    const config = getRouteConfig(route)

    // OpenAPI groups by path and then method
    const path = route.url.replace(/:([A-Z_a-z]+)/g, '{$1}')
    if (!spec.paths[path]) {
      spec.paths[path] = {}
    }

    // Sort available methods
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).sort(
      (a, b) => methodsOrder.indexOf(a) - methodsOrder.indexOf(b)
    )

    // Get OpenAPI supported tags
    const { summary, description, tags, security } = config.openapi ?? {}

    // Add the new operation
    for (const method of methods) {
      const schema: FastifySchema = route.schema ?? {}

      spec.paths[path][method.toLowerCase()] = {
        summary,
        description,
        tags,
        security,
        parameters: parseParameters(instance, schema),
        responses: 'response' in schema ? parseResponses(schema.response as Response) : undefined,
        requestBody:
          'body' in schema && ['PUT', 'PATCH', 'POST'].includes(method)
            ? parsePayload(schema.body as Schema)
            : undefined
      }
    }
  }

  // Now traverse the entire spec and replace $ref to reflect OpenAPI hierarchy and also to return nulls and undefineds
  return cleanSpec(spec)
}
