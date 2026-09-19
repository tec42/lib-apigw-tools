#!/usr/bin/env node
/**
 * Bundle OpenAPI spec for AWS API Gateway import.
 *
 * Resolves all $ref splits in a service's openapi.yaml, prefixes all paths
 * with the service path prefix, adds x-amazon-apigateway-integration
 * extensions, and uploads the result to S3.
 *
 * Required env vars:
 *   SERVICE_NAME   — Service identifier (e.g. "identity", "cook")
 *   NLB_DNS        — Internal NLB DNS name (not needed with INTEGRATION_HOST)
 *   VPC_LINK_ID    — API Gateway VPC Link ID
 *
 * Optional env vars:
 *   PATH_PREFIX    — API Gateway path prefix (default: /${SERVICE_NAME}/v1)
 *   NLB_PORT       — NLB port the service listens on (default: 3010)
 *   INTEGRATION_HOST — HTTPS: a name the NLB TLS listener's certificate covers
 *                    (e.g. identity-internal.tec42.io). Unset: plain http://NLB_DNS:NLB_PORT.
 *   INTEGRATION_PORT — HTTPS: the TLS listener's port. Required with INTEGRATION_HOST.
 *   SERVICE_API_PREFIX — Service-internal API prefix (default: /api/v1)
 *   OPENAPI_SPEC   — Path to openapi.yaml (default: app/api/openapi.yaml, relative to cwd)
 *   S3_BUCKET      — S3 bucket for spec upload (default: tec42-terraform-state)
 *   S3_KEY_PREFIX  — S3 key prefix (default: api-gateway-specs)
 *   DRY_RUN        — If set, write to stdout only (no S3 upload)
 *   OUTPUT_FILE    — If set, write JSON to this file instead of uploading to S3
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPrefixedPaths, integrationTarget } from './apigw-integrations.mjs'

// --- CLI entry point ---
{
  // Validate required env vars
  const SERVICE_NAME = process.env.SERVICE_NAME
  const NLB_DNS = process.env.NLB_DNS
  const VPC_LINK_ID = process.env.VPC_LINK_ID

  // NLB_DNS only feeds the plain-HTTP target; an HTTPS integration names its host instead.
  const required = process.env.INTEGRATION_HOST
    ? ['SERVICE_NAME', 'VPC_LINK_ID']
    : ['SERVICE_NAME', 'NLB_DNS', 'VPC_LINK_ID']
  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0) {
    console.error(`❌ Missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }

  // Optional env vars with defaults
  const PATH_PREFIX = process.env.PATH_PREFIX ?? `/${SERVICE_NAME}/v1`
  const NLB_PORT = process.env.NLB_PORT ?? '3010'
  const SERVICE_API_PREFIX = process.env.SERVICE_API_PREFIX ?? '/api/v1'
  const OPENAPI_SPEC = process.env.OPENAPI_SPEC ?? 'app/api/openapi.yaml'
  const S3_BUCKET = process.env.S3_BUCKET ?? 'tec42-terraform-state'
  const S3_KEY_PREFIX = process.env.S3_KEY_PREFIX ?? 'api-gateway-specs'
  const DRY_RUN = !!process.env.DRY_RUN
  const OUTPUT_FILE = process.env.OUTPUT_FILE ?? null

  let TARGET
  try {
    TARGET = integrationTarget({
      nlbDns: NLB_DNS,
      nlbPort: NLB_PORT,
      integrationHost: process.env.INTEGRATION_HOST,
      integrationPort: process.env.INTEGRATION_PORT,
    })
  } catch (error) {
    console.error(`❌ ${error.message}`)
    process.exit(1)
  }

  const cwd = process.cwd()
  const specPath = resolve(cwd, OPENAPI_SPEC)

  if (!existsSync(specPath)) {
    console.error(`❌ OpenAPI spec not found: ${specPath}`)
    process.exit(1)
  }

  console.log(`🚀 Bundling OpenAPI spec for service: ${SERVICE_NAME}`)
  console.log(`   Spec:       ${specPath}`)
  console.log(`   Prefix:     ${PATH_PREFIX}`)
  console.log(`   NLB target: ${TARGET}${SERVICE_API_PREFIX}`)
  if (DRY_RUN) console.log('   Mode:       DRY RUN (no S3 upload)')
  if (OUTPUT_FILE) console.log(`   Output:     ${OUTPUT_FILE} (no S3 upload)`)
  // Step 1: Bundle OpenAPI spec (resolve all $refs via redocly)
  const tmpBundled = join(tmpdir(), `openapi-bundled-${Date.now()}.json`)

  console.log('\n📦 Bundling $refs...')

  // Check for redocly: 1) in project's node_modules, 2) bundled with this package (via npx), 3) fallback npx
  const redoclyLocal = resolve(cwd, 'node_modules/.bin/redocly')
  const __pkgDir = dirname(fileURLToPath(import.meta.url))
  const redoclyBundled = resolve(__pkgDir, '../../.bin/redocly')
  const [redocloBin, redoclyArgs] = existsSync(redoclyLocal)
    ? [redoclyLocal, ['bundle', OPENAPI_SPEC, '-o', tmpBundled]]
    : existsSync(redoclyBundled)
    ? [redoclyBundled, ['bundle', OPENAPI_SPEC, '-o', tmpBundled]]
    : ['npx', ['--yes', '@redocly/cli', 'bundle', OPENAPI_SPEC, '-o', tmpBundled]]

  execFileSync(redocloBin, redoclyArgs, { cwd, stdio: 'inherit' })

  const spec = JSON.parse(readFileSync(tmpBundled, 'utf-8'))
  unlinkSync(tmpBundled)

  // AWS API Gateway only supports OpenAPI 3.0.x — downgrade 3.1.x to 3.0.1
  if (spec.openapi && spec.openapi.startsWith('3.1')) {
    console.log(`\n⚠️  Downgrading OpenAPI ${spec.openapi} → 3.0.1 (API Gateway requirement)`)
    spec.openapi = '3.0.1'
  }

  // Step 2: Prefix all paths + add x-amazon-apigateway-integration
  const prefixedPaths = buildPrefixedPaths(spec, {
    pathPrefix: PATH_PREFIX,
    target: TARGET,
    serviceApiPrefix: SERVICE_API_PREFIX,
    vpcLinkId: VPC_LINK_ID,
  })

  spec.paths = prefixedPaths

  const pathCount = Object.keys(prefixedPaths).length
  console.log(`\n✅ ${pathCount} paths prefixed with ${PATH_PREFIX}`)

  // Step 3: Output
  const outputJson = JSON.stringify(spec, null, 2)

  if (DRY_RUN) {
    const tmpOut = join(tmpdir(), `openapi-apigw-${SERVICE_NAME}-${Date.now()}.json`)
    writeFileSync(tmpOut, outputJson, 'utf-8')
    console.log(`\n🔍 DRY RUN — written to: ${tmpOut}`)
    process.exit(0)
  }

  if (OUTPUT_FILE) {
    writeFileSync(OUTPUT_FILE, outputJson, 'utf-8')
    console.log(`\n✅ Written to: ${OUTPUT_FILE}`)
    process.exit(0)
  }

  // Step 4: Upload to S3
  const s3Key = `${S3_KEY_PREFIX}/${SERVICE_NAME}.json`
  const s3Uri = `s3://${S3_BUCKET}/${s3Key}`

  const tmpUpload = join(tmpdir(), `openapi-apigw-${SERVICE_NAME}-upload-${Date.now()}.json`)
  writeFileSync(tmpUpload, outputJson, 'utf-8')

  console.log(`\n☁️  Uploading to ${s3Uri}...`)

  try {
    execFileSync('aws', ['s3', 'cp', tmpUpload, s3Uri, '--content-type', 'application/json', '--sse', 'AES256'], {
      stdio: 'inherit',
    })
    console.log(`✅ Uploaded: ${s3Uri}`)
  } finally {
    unlinkSync(tmpUpload)
  }
}
