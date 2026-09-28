import { domainToASCII } from 'node:url'
import tencentcloud from 'tencentcloud-sdk-nodejs-dnspod'

const DnspodClient = tencentcloud.dnspod.v20210323.Client
const PAGE_SIZE = 100

export interface MatchedDomain {
  domainName: string
  hostRecordPrefix: string
}

export function normalizeDomain(rawDomain: string): string {
  const input = rawDomain.trim().replace(/^\*\./, '').replace(/\.$/, '')
  if (/[\s/\\:@?#%]/.test(input)) throw new Error('CERTBOT_DOMAIN must be a valid domain name.')
  const domain = domainToASCII(input).toLowerCase()
  const labels = domain.split('.')
  if (
    domain.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error('CERTBOT_DOMAIN must be a valid domain name.')
  }
  return domain
}

export function challengeRecordName(hostRecordPrefix: string): string {
  return hostRecordPrefix ? `_acme-challenge.${hostRecordPrefix}` : '_acme-challenge'
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}

export class TencentCloudDNS {
  private readonly client: InstanceType<typeof DnspodClient>

  constructor(secretId: string, secretKey: string, token?: string) {
    this.client = new DnspodClient({
      credential: { secretId, secretKey, ...(token ? { token } : {}) },
      region: '',
      profile: { httpProfile: { endpoint: 'dnspod.tencentcloudapi.com', reqTimeout: 30 } },
    })
  }

  /** Prefer the most specific zone hosted in this DNSPod account. */
  async findMatchedDomainId(fullDomain: string): Promise<MatchedDomain | null> {
    const parts = normalizeDomain(fullDomain).split('.')
    for (let i = 0; i < parts.length - 1; i++) {
      const domainName = parts.slice(i).join('.')
      if (await this.checkDomainExists(domainName)) {
        return { domainName, hostRecordPrefix: parts.slice(0, i).join('.') }
      }
    }
    return null
  }

  async checkDomainExists(domainName: string): Promise<boolean> {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const result = await this.client.DescribeDomainList({
        Type: 'ALL',
        Keyword: domainName,
        Offset: offset,
        Limit: PAGE_SIZE,
      })
      const domains = result.DomainList ?? []
      if (domains.some((item) => typeof item.Name === 'string' && normalizeDomain(item.Name) === domainName))
        return true
      if (domains.length < PAGE_SIZE) return false
    }
  }

  async addResourceRecord(domainName: string, hostRecord: string, hostValue: string): Promise<number> {
    const result = await this.client.CreateRecord({
      Domain: domainName,
      SubDomain: hostRecord,
      RecordType: 'TXT',
      RecordLine: '默认',
      Value: hostValue,
    })
    const recordId = result.RecordId
    if (typeof recordId !== 'number' || !Number.isSafeInteger(recordId) || recordId <= 0) {
      throw new Error('CreateRecord did not return a valid RecordId.')
    }
    return recordId
  }

  /** Match both name and value so other simultaneous challenges survive cleanup. */
  async findResourceRecordId(domainName: string, hostRecord: string, hostValue: string): Promise<number | null> {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let result
      try {
        result = await this.client.DescribeRecordList({
          Domain: domainName,
          SubDomain: hostRecord,
          RecordType: 'TXT',
          RecordLine: '默认',
          Offset: offset,
          Limit: PAGE_SIZE,
          ErrorOnEmpty: 'no',
        })
      } catch (error) {
        if (errorCode(error) === 'ResourceNotFound.NoDataOfRecord') return null
        throw error
      }
      const records = result.RecordList ?? []
      const match = records.find((item) => item.Name === hostRecord && item.Type === 'TXT' && item.Value === hostValue)
      if (match) {
        if (typeof match.RecordId !== 'number' || !Number.isSafeInteger(match.RecordId) || match.RecordId <= 0) {
          throw new Error('DescribeRecordList did not return a valid RecordId for the matching TXT record.')
        }
        return match.RecordId
      }
      if (records.length < PAGE_SIZE) return null
    }
  }

  async deleteResourceRecord(domainName: string, recordId: number): Promise<void> {
    await this.client.DeleteRecord({ Domain: domainName, RecordId: recordId })
  }
}
