import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrefixedPaths, integrationTarget } from './apigw-integrations.mjs'

const OPTIONS = {
  pathPrefix: '/identity/v1',
  target: 'http://test-nlb.internal.example.com:3010',
  serviceApiPrefix: '/api/v1',
  vpcLinkId: 'abc123',
}

describe('buildPrefixedPaths', () => {
  it('prefixes all paths with the path prefix', () => {
    const spec = {
      paths: {
        '/health': { get: { responses: { 200: {} } } },
        '/users': { get: { responses: { 200: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)

    assert.ok(result['/identity/v1/health'], 'should have /identity/v1/health')
    assert.ok(result['/identity/v1/users'], 'should have /identity/v1/users')
    assert.equal(Object.keys(result).length, 2)
  })

  it('adds x-amazon-apigateway-integration to each HTTP method', () => {
    const spec = {
      paths: {
        '/users': {
          get: { responses: { 200: {} } },
          post: { responses: { 201: {} } },
        },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)
    const pathItem = result['/identity/v1/users']

    assert.ok(pathItem.get['x-amazon-apigateway-integration'], 'GET should have integration')
    assert.ok(pathItem.post['x-amazon-apigateway-integration'], 'POST should have integration')
  })

  it('sets correct integration URI with NLB target', () => {
    const spec = {
      paths: {
        '/health': { get: { responses: { 200: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)
    const integration = result['/identity/v1/health'].get['x-amazon-apigateway-integration']

    assert.equal(integration.type, 'HTTP_PROXY')
    assert.equal(integration.httpMethod, 'GET')
    assert.equal(integration.uri, 'http://test-nlb.internal.example.com:3010/api/v1/health')
    assert.equal(integration.connectionType, 'VPC_LINK')
    assert.equal(integration.connectionId, 'abc123')
  })

  it('builds an HTTPS integration URI from an HTTPS target', () => {
    const spec = {
      paths: {
        '/users/{id}': { get: { responses: { 200: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, {
      ...OPTIONS,
      target: 'https://identity-internal.tec42.io:3012',
    })
    const integration = result['/identity/v1/users/{id}'].get['x-amazon-apigateway-integration']

    assert.equal(integration.uri, 'https://identity-internal.tec42.io:3012/api/v1/users/{id}')
    assert.equal(integration.connectionType, 'VPC_LINK')
    assert.equal(integration.connectionId, 'abc123')
    assert.equal(integration.tlsConfig, undefined, 'must never skip certificate verification')
  })

  it('maps path parameters to requestParameters', () => {
    const spec = {
      paths: {
        '/users/{id}': { get: { responses: { 200: {} } } },
        '/families/{familyId}/members/{memberId}': { delete: { responses: { 204: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)

    const singleParam = result['/identity/v1/users/{id}'].get['x-amazon-apigateway-integration']
    assert.deepEqual(singleParam.requestParameters, {
      'integration.request.path.id': 'method.request.path.id',
    })

    const multiParam =
      result['/identity/v1/families/{familyId}/members/{memberId}'].delete[
        'x-amazon-apigateway-integration'
      ]
    assert.deepEqual(multiParam.requestParameters, {
      'integration.request.path.familyId': 'method.request.path.familyId',
      'integration.request.path.memberId': 'method.request.path.memberId',
    })
  })

  it('omits requestParameters when path has no parameters', () => {
    const spec = {
      paths: {
        '/health': { get: { responses: { 200: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)
    const integration = result['/identity/v1/health'].get['x-amazon-apigateway-integration']

    assert.equal(integration.requestParameters, undefined)
  })

  it('returns empty object for spec with no paths', () => {
    const result = buildPrefixedPaths({ paths: {} }, OPTIONS)
    assert.deepEqual(result, {})
  })

  it('returns empty object when paths key is missing', () => {
    const result = buildPrefixedPaths({}, OPTIONS)
    assert.deepEqual(result, {})
  })

  it('handles all supported HTTP methods', () => {
    const spec = {
      paths: {
        '/resource': {
          get: { responses: { 200: {} } },
          post: { responses: { 201: {} } },
          put: { responses: { 200: {} } },
          patch: { responses: { 200: {} } },
          delete: { responses: { 204: {} } },
          head: { responses: { 200: {} } },
          options: { responses: { 200: {} } },
        },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)
    const pathItem = result['/identity/v1/resource']

    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      assert.ok(
        pathItem[method]['x-amazon-apigateway-integration'],
        `${method} should have integration`,
      )
      assert.equal(
        pathItem[method]['x-amazon-apigateway-integration'].httpMethod,
        method.toUpperCase(),
      )
    }
  })

  it('uses custom PATH_PREFIX when provided', () => {
    const spec = {
      paths: {
        '/health': { get: { responses: { 200: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, { ...OPTIONS, pathPrefix: '/cook/v2' })

    assert.ok(result['/cook/v2/health'], 'should use custom prefix')
    assert.equal(Object.keys(result).length, 1)
  })
})

describe('integrationTarget', () => {
  const NLB = { nlbDns: 'test-nlb.internal.example.com', nlbPort: '3010' }

  it('stays plain http://NLB_DNS:NLB_PORT when no integration host is given', () => {
    assert.equal(integrationTarget(NLB), 'http://test-nlb.internal.example.com:3010')
  })

  it('treats empty strings as unset, as an empty Makefile variable arrives', () => {
    assert.equal(
      integrationTarget({ ...NLB, integrationHost: '', integrationPort: '' }),
      'http://test-nlb.internal.example.com:3010',
    )
  })

  it('switches to https://INTEGRATION_HOST:INTEGRATION_PORT and ignores the NLB name', () => {
    assert.equal(
      integrationTarget({
        ...NLB,
        integrationHost: 'identity-internal.tec42.io',
        integrationPort: '3012',
      }),
      'https://identity-internal.tec42.io:3012',
    )
  })

  it('needs no NLB name in HTTPS mode', () => {
    assert.equal(
      integrationTarget({ integrationHost: 'catalog-internal.tec42.io', integrationPort: '3022' }),
      'https://catalog-internal.tec42.io:3022',
    )
  })

  it('refuses a host without a port instead of falling back to the plain-HTTP port', () => {
    assert.throws(
      () => integrationTarget({ ...NLB, integrationHost: 'identity-internal.tec42.io' }),
      /INTEGRATION_HOST is set without INTEGRATION_PORT/,
    )
  })

  it('refuses a port without a host', () => {
    assert.throws(
      () => integrationTarget({ ...NLB, integrationPort: '3012' }),
      /INTEGRATION_PORT is set without INTEGRATION_HOST/,
    )
  })

  it('refuses a port that is not a number', () => {
    assert.throws(
      () =>
        integrationTarget({
          ...NLB,
          integrationHost: 'identity-internal.tec42.io',
          integrationPort: '3012/api',
        }),
      /INTEGRATION_PORT must be a port number/,
    )
  })

  it('refuses the raw NLB name, which no certificate covers', () => {
    assert.throws(
      () =>
        integrationTarget({
          integrationHost: 'tec42-internal-nlb-production-0123.elb.eu-central-1.amazonaws.com',
          integrationPort: '3012',
        }),
      /raw NLB name/,
    )
  })
})
