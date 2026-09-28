import { setTimeout } from 'node:timers/promises'
import { challengeRecordName, normalizeDomain, TencentCloudDNS } from './tencent-cloud-dns.js'

export interface HookConfig {
  secretId: string
  secretKey: string
  token?: string
  domain: string
  validation: string
  propagationSeconds: number
}

type HookDNS = Pick<
  TencentCloudDNS,
  'findMatchedDomainId' | 'addResourceRecord' | 'findResourceRecordId' | 'deleteResourceRecord'
>

export function readConfig(env: NodeJS.ProcessEnv, auth: boolean): HookConfig {
  const required = ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY', 'CERTBOT_DOMAIN', 'CERTBOT_VALIDATION']
  const missing = required.filter((name) => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`)

  const rawSeconds = env['TENCENTCLOUD_DNS_PROPAGATION_SECONDS'] ?? '60'
  const propagationSeconds = auth ? Number(rawSeconds) : 60
  if (
    auth &&
    (!/^\d+$/.test(rawSeconds) || !Number.isSafeInteger(propagationSeconds) || propagationSeconds > 2147483)
  ) {
    throw new Error('TENCENTCLOUD_DNS_PROPAGATION_SECONDS must be a non-negative integer (maximum 2147483).')
  }

  const token = env['TENCENTCLOUD_TOKEN']?.trim()
  return {
    secretId: env['TENCENTCLOUD_SECRET_ID']!.trim(),
    secretKey: env['TENCENTCLOUD_SECRET_KEY']!.trim(),
    ...(token ? { token } : {}),
    domain: normalizeDomain(env['CERTBOT_DOMAIN']!),
    validation: env['CERTBOT_VALIDATION']!,
    propagationSeconds,
  }
}

export async function runAuth(
  api: HookDNS,
  config: HookConfig,
  wait: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<void> {
  console.error(`Finding matched DNSPod domain for ${config.domain}...`)
  const matched = await api.findMatchedDomainId(config.domain)
  if (!matched) throw new Error(`No matching domain for ${config.domain} in Tencent Cloud DNSPod account.`)

  const recordName = challengeRecordName(matched.hostRecordPrefix)
  const recordId = await api.addResourceRecord(matched.domainName, recordName, config.validation)
  console.error(`TXT record ${recordName}.${matched.domainName} added (ID: ${recordId}).`)
  console.error(`Wait ${config.propagationSeconds} seconds for DNS propagation...`)
  await wait(config.propagationSeconds * 1000)
}

export async function runCleanup(api: HookDNS, config: HookConfig): Promise<void> {
  console.error(`Finding matched DNSPod domain for ${config.domain} to cleanup...`)
  const matched = await api.findMatchedDomainId(config.domain)
  if (!matched) {
    console.error(`No matching domain for ${config.domain}, skipping cleanup.`)
    return
  }

  const recordName = challengeRecordName(matched.hostRecordPrefix)
  const recordId = await api.findResourceRecordId(matched.domainName, recordName, config.validation)
  if (recordId === null) {
    console.error('No matching TXT validation record found, nothing to cleanup.')
    return
  }
  await api.deleteResourceRecord(matched.domainName, recordId)
  console.error(`TXT validation record deleted (ID: ${recordId}).`)
}

export function reportError(hook: string, error: unknown): void {
  // Avoid printing SDK request objects, which can contain credentials and signatures.
  console.error(`Tencent Cloud DNS ${hook} Hook failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  process.exitCode = 1
}
