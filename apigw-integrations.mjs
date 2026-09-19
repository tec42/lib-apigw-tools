/**
 * The pure part of the bundler: integration targets and prefixed paths.
 *
 * Kept apart from bundle-apigw-spec.mjs because that file runs the CLI the moment it is imported
 * (there is no isMain guard — npx's bin wrapper breaks the argv[1] check), so tests could not import
 * anything from it.
 */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

/**
 * The scheme, host and port every integration of a service points at.
 *
 * Without integrationHost: `http://<nlbDns>:<nlbPort>`, exactly what every service got before HTTPS
 * existed. All services install this library from an unpinned main, so this default must not move.
 *
 * With integrationHost: `https://<integrationHost>:<integrationPort>`. API Gateway validates an HTTPS
 * integration's certificate against the host in the integration URI, so the host must be a name the
 * NLB listener's certificate covers (e.g. `identity-internal.tec42.io`) and the port that listener's.
 * The raw NLB name is refused: no certificate covers `*.elb.<region>.amazonaws.com`, and every
 * request would fail at the gateway while the import itself succeeds.
 *
 * @param {object} options
 * @param {string} [options.nlbDns]          - Internal NLB DNS name (plain-HTTP mode)
 * @param {string} [options.nlbPort]         - NLB port (plain-HTTP mode)
 * @param {string} [options.integrationHost] - Name the listener's certificate covers (HTTPS mode)
 * @param {string} [options.integrationPort] - The TLS listener's port (HTTPS mode)
 * @returns {string} e.g. "https://identity-internal.tec42.io:3012"
 */
export function integrationTarget({ nlbDns, nlbPort, integrationHost, integrationPort }) {
  const host = integrationHost || undefined
  const port = integrationPort || undefined

  if (host === undefined && port === undefined) {
    return `http://${nlbDns}:${nlbPort}`
  }
  if (host === undefined) {
    throw new Error('INTEGRATION_PORT is set without INTEGRATION_HOST: HTTPS needs both')
  }
  if (port === undefined) {
    throw new Error('INTEGRATION_HOST is set without INTEGRATION_PORT: HTTPS needs both')
  }
  if (!/^\d+$/.test(port)) {
    throw new Error(`INTEGRATION_PORT must be a port number, got "${port}"`)
  }
  if (/\.elb\.([a-z0-9-]+\.)?amazonaws\.com$/i.test(host)) {
    throw new Error(
      `INTEGRATION_HOST "${host}" is the raw NLB name: no certificate covers it, so API Gateway ` +
        'would fail every request. Use the name the listener certificate covers.',
    )
  }
  return `https://${host}:${port}`
}

/**
 * Prefix all paths in an OpenAPI spec and add x-amazon-apigateway-integration extensions.
 *
 * @param {object} spec - Parsed OpenAPI spec object (mutated: paths replaced)
 * @param {object} options
 * @param {string} options.pathPrefix       - e.g. "/identity/v1"
 * @param {string} options.target           - Scheme, host and port, from integrationTarget()
 * @param {string} options.serviceApiPrefix - e.g. "/api/v1"
 * @param {string} options.vpcLinkId        - API Gateway VPC Link ID
 * @returns {Record<string, unknown>} prefixedPaths
 */
export function buildPrefixedPaths(spec, { pathPrefix, target, serviceApiPrefix, vpcLinkId }) {
  const prefixedPaths = {}

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const prefixedPath = `${pathPrefix}${path}`

    // Extract path parameter names, e.g. {id}, {familyId}
    const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])

    for (const method of HTTP_METHODS) {
      if (!pathItem[method]) continue

      const requestParameters = {}
      for (const param of pathParams) {
        requestParameters[`integration.request.path.${param}`] = `method.request.path.${param}`
      }

      pathItem[method]['x-amazon-apigateway-integration'] = {
        type: 'HTTP_PROXY',
        httpMethod: method.toUpperCase(),
        uri: `${target}${serviceApiPrefix}${path}`,
        connectionType: 'VPC_LINK',
        connectionId: vpcLinkId,
        ...(Object.keys(requestParameters).length > 0 ? { requestParameters } : {}),
      }
    }

    prefixedPaths[prefixedPath] = pathItem
  }

  return prefixedPaths
}
