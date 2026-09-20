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
 * **HTTPS is the default and the only thing production gets.** `integrationHost` plus
 * `integrationPort` produce `https://<host>:<port>`. API Gateway validates an HTTPS integration's
 * certificate against the host in the integration URI, so the host must be a name the NLB listener's
 * certificate covers (e.g. `identity-internal.tec42.io`) and the port must be that listener's. The raw
 * NLB name is refused: no certificate covers `*.elb.<region>.amazonaws.com`, and every request would
 * fail at the gateway while the import itself succeeds.
 *
 * **Plain HTTP now takes an explicit decision, with a reason.** Until 2026-09-20 an unset
 * `integrationHost` silently produced `http://<nlbDns>:<nlbPort>`, and `nlbPort` defaulted to 3010 —
 * identity's port, which is how exposee-optimizer's routes once pointed at identity. Both defaults are
 * gone. A caller that names neither host nor port now fails, and a caller that really wants plaintext
 * has to set `allowPlaintext` to a reason and name both `nlbDns` and `nlbPort` itself.
 *
 * @param {object} options
 * @param {string} [options.nlbDns]          - Internal NLB DNS name (plaintext mode only)
 * @param {string} [options.nlbPort]         - NLB port (plaintext mode only)
 * @param {string} [options.integrationHost] - Name the listener's certificate covers
 * @param {string} [options.integrationPort] - The TLS listener's port
 * @param {string} [options.allowPlaintext]  - The reason plaintext is acceptable here; any non-empty
 *                                             string opts out of HTTPS, and it is echoed in the output
 * @returns {string} e.g. "https://identity-internal.tec42.io:3012"
 */
export function integrationTarget({
  nlbDns,
  nlbPort,
  integrationHost,
  integrationPort,
  allowPlaintext,
} = {}) {
  const host = integrationHost || undefined
  const port = integrationPort || undefined
  const plaintextReason = allowPlaintext || undefined

  if (plaintextReason !== undefined) {
    if (host !== undefined) {
      throw new Error(
        'INTEGRATION_ALLOW_PLAINTEXT is set together with INTEGRATION_HOST: decide one. ' +
          'Unset INTEGRATION_ALLOW_PLAINTEXT to get HTTPS.',
      )
    }
    const missing = [
      ...(nlbDns ? [] : ['NLB_DNS']),
      ...(nlbPort ? [] : ['NLB_PORT']),
    ]
    if (missing.length > 0) {
      throw new Error(
        `Plaintext mode needs ${missing.join(' and ')}: there is no default port any more, because a ` +
          'default that is correct for exactly one of five services is how exposee-optimizer ended up ' +
          "pointing at identity's 3010.",
      )
    }
    if (!/^\d+$/.test(nlbPort)) {
      throw new Error(`NLB_PORT must be a port number, got "${nlbPort}"`)
    }
    return `http://${nlbDns}:${nlbPort}`
  }

  if (host === undefined && port === undefined) {
    throw new Error(
      'INTEGRATION_HOST and INTEGRATION_PORT are required: services talk HTTPS only. Use the name the ' +
        "NLB listener's certificate covers and its TLS port, e.g. " +
        'INTEGRATION_HOST=vehicle-manager-internal.tec42.io INTEGRATION_PORT=3052. If this caller really ' +
        'has to emit plain HTTP, set INTEGRATION_ALLOW_PLAINTEXT to the reason and name NLB_DNS and ' +
        'NLB_PORT yourself.',
    )
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
