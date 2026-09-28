import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import tencentcloud from 'tencentcloud-sdk-nodejs-dnspod'
import { readConfig, runAuth, runCleanup } from '../src/hooks.js'
import { challengeRecordName, normalizeDomain, TencentCloudDNS } from '../src/tencent-cloud-dns.js'

const Client = tencentcloud.dnspod.v20210323.Client
type DNSPodClient = InstanceType<typeof Client>
type DomainListRequest = Parameters<DNSPodClient['DescribeDomainList']>[0]
type RecordListRequest = Parameters<DNSPodClient['DescribeRecordList']>[0]
type DeleteRecordRequest = Parameters<DNSPodClient['DeleteRecord']>[0]
const environment = {
  TENCENTCLOUD_SECRET_ID: 'test-secret-id',
  TENCENTCLOUD_SECRET_KEY: 'test-secret-key',
  CERTBOT_DOMAIN: 'example.com',
  CERTBOT_VALIDATION: 'validation-root',
}

test('normalizes wildcard, case, trailing dot and international domain names', () => {
  assert.equal(normalizeDomain('*.Example.COM.'), 'example.com')
  assert.equal(normalizeDomain('例子.com'), 'xn--fsqu00a.com')
  assert.equal(challengeRecordName(''), '_acme-challenge')
  assert.equal(challengeRecordName('a.b'), '_acme-challenge.a.b')
  for (const domain of [
    'localhost',
    'a..com',
    '-example.com',
    '*.com',
    'foo.*.example.com',
    'example.com/path',
    'example.com?x',
    'example.com#x',
    'example%2ecom',
    '',
  ]) {
    assert.throws(() => normalizeDomain(domain), /valid domain name/)
  }
})

test('validates required variables and propagation delay before any DNS operation', () => {
  assert.throws(() => readConfig({}, true), /TENCENTCLOUD_SECRET_ID.*CERTBOT_VALIDATION/)
  assert.throws(() => readConfig({ ...environment, CERTBOT_VALIDATION: '' }, false), /CERTBOT_VALIDATION/)
  assert.equal(readConfig(environment, true).propagationSeconds, 60)
  assert.equal(readConfig({ ...environment, TENCENTCLOUD_DNS_PROPAGATION_SECONDS: '0' }, true).propagationSeconds, 0)
  assert.equal(readConfig({ ...environment, TENCENTCLOUD_TOKEN: 'temporary-token' }, true).token, 'temporary-token')
  for (const delay of ['-1', '1.5', 'NaN', '', '2147484']) {
    assert.throws(
      () => readConfig({ ...environment, TENCENTCLOUD_DNS_PROPAGATION_SECONDS: delay }, true),
      /non-negative integer/,
    )
  }
  // Cleanup must still run when an auth-only setting was invalid.
  assert.doesNotThrow(() => readConfig({ ...environment, TENCENTCLOUD_DNS_PROPAGATION_SECONDS: 'invalid' }, false))
})

test('chooses the most specific hosted zone and rejects substring-only matches', async (t) => {
  const describe = t.mock.method(Client.prototype, 'DescribeDomainList', async (request: DomainListRequest) => {
    const names = ['example.com', 'b.example.com', 'other-a.b.example.com']
    return { DomainList: names.filter((name) => name.includes(request.Keyword ?? '')).map((Name) => ({ Name })) }
  })
  const api = new TencentCloudDNS('id', 'key')
  assert.deepEqual(await api.findMatchedDomainId('*.A.B.Example.COM.'), {
    domainName: 'b.example.com',
    hostRecordPrefix: 'a',
  })
  assert.deepEqual(
    describe.mock.calls.map((call) => call.arguments[0]?.Keyword),
    ['a.b.example.com', 'b.example.com'],
  )
})

test('finds domains beyond the first API page', async (t) => {
  const describe = t.mock.method(Client.prototype, 'DescribeDomainList', async (request: DomainListRequest) => ({
    DomainList:
      request.Offset === 0
        ? Array.from({ length: 100 }, (_, i) => ({ Name: `other${i}.example.com` }))
        : [{ Name: 'example.com' }],
  }))
  assert.equal(await new TencentCloudDNS('id', 'key').checkDomainExists('example.com'), true)
  assert.deepEqual(
    describe.mock.calls.map((call) => call.arguments[0]?.Offset),
    [0, 100],
  )
})

test('returns no match for an unhosted domain but propagates authentication errors', async (t) => {
  const describe = t.mock.method(Client.prototype, 'DescribeDomainList', async () => ({ DomainList: [] }))
  const api = new TencentCloudDNS('id', 'key')
  assert.equal(await api.findMatchedDomainId('www.example.com'), null)
  describe.mock.mockImplementation(async () => {
    throw new Error('AuthFailure.SignatureFailure')
  })
  await assert.rejects(api.findMatchedDomainId('www.example.com'), /AuthFailure/)
})

test('auth creates a default-line TXT record and waits for the configured propagation delay', async (t) => {
  t.mock.method(console, 'error', () => {})
  t.mock.method(Client.prototype, 'DescribeDomainList', async () => ({ DomainList: [{ Name: 'example.com' }] }))
  const create = t.mock.method(Client.prototype, 'CreateRecord', async () => ({ RecordId: 42 }))
  const waits: number[] = []
  await runAuth(
    new TencentCloudDNS('id', 'key'),
    readConfig({ ...environment, CERTBOT_DOMAIN: 'a.b.example.com' }, true),
    async (ms) => {
      waits.push(ms)
    },
  )
  assert.deepEqual(create.mock.calls[0]?.arguments[0], {
    Domain: 'example.com',
    SubDomain: '_acme-challenge.a.b',
    RecordType: 'TXT',
    RecordLine: '默认',
    Value: 'validation-root',
  })
  assert.deepEqual(waits, [60000])
})

test('auth stops on a missing zone or failed creation without waiting', async (t) => {
  t.mock.method(console, 'error', () => {})
  const describe = t.mock.method(Client.prototype, 'DescribeDomainList', async () => ({ DomainList: [] }))
  const create = t.mock.method(Client.prototype, 'CreateRecord', async () => ({ RecordId: 42 }))
  const wait = t.mock.fn(async () => {})
  const api = new TencentCloudDNS('id', 'key')
  const config = readConfig(environment, true)
  await assert.rejects(runAuth(api, config, wait), /No matching domain/)
  assert.equal(create.mock.callCount(), 0)
  describe.mock.mockImplementation(async () => ({ DomainList: [{ Name: 'example.com' }] }))
  create.mock.mockImplementation(async () => {
    throw new Error('CreateRecord denied')
  })
  await assert.rejects(runAuth(api, config, wait), /CreateRecord denied/)
  assert.equal(wait.mock.callCount(), 0)
})

test('rejects CreateRecord responses with no usable record ID', async (t) => {
  t.mock.method(Client.prototype, 'CreateRecord', async () => ({}))
  await assert.rejects(
    new TencentCloudDNS('id', 'key').addResourceRecord('example.com', '_acme-challenge', 'value'),
    /RecordId/,
  )
})

test('cleanup preserves the other challenge when requesting root and wildcard together', async (t) => {
  t.mock.method(console, 'error', () => {})
  t.mock.method(Client.prototype, 'DescribeDomainList', async () => ({ DomainList: [{ Name: 'example.com' }] }))
  const records = [
    { RecordId: 1, Name: '_acme-challenge', Type: 'TXT', Value: 'validation-root' },
    { RecordId: 2, Name: '_acme-challenge', Type: 'TXT', Value: 'validation-wildcard' },
    { RecordId: 3, Name: '_acme-challenge.other', Type: 'TXT', Value: 'validation-root' },
    { RecordId: 4, Name: '_acme-challenge', Type: 'CNAME', Value: 'validation-root' },
  ]
  t.mock.method(Client.prototype, 'DescribeRecordList', async () => ({ RecordList: [...records] }))
  const remove = t.mock.method(Client.prototype, 'DeleteRecord', async (request: DeleteRecordRequest) => {
    const index = records.findIndex((record) => record.RecordId === request.RecordId)
    assert.notEqual(index, -1)
    records.splice(index, 1)
    return {}
  })
  const api = new TencentCloudDNS('id', 'key')
  await runCleanup(api, readConfig(environment, false))
  assert.deepEqual(
    records.map((record) => record.RecordId),
    [2, 3, 4],
  )
  await runCleanup(
    api,
    readConfig({ ...environment, CERTBOT_DOMAIN: '*.example.com', CERTBOT_VALIDATION: 'validation-wildcard' }, false),
  )
  assert.deepEqual(
    records.map((record) => record.RecordId),
    [3, 4],
  )
  // Repeated cleanup is a no-op.
  await runCleanup(api, readConfig(environment, false))
  assert.equal(remove.mock.callCount(), 2)
  assert.deepEqual(remove.mock.calls[0]?.arguments[0], { Domain: 'example.com', RecordId: 1 })
})

test('finds the matching TXT value beyond the first record page', async (t) => {
  const describe = t.mock.method(Client.prototype, 'DescribeRecordList', async (request: RecordListRequest) => ({
    RecordList:
      request.Offset === 0
        ? Array.from({ length: 100 }, (_, i) => ({
            RecordId: i + 1,
            Name: '_acme-challenge',
            Type: 'TXT',
            Value: `other-${i}`,
          }))
        : [{ RecordId: 101, Name: '_acme-challenge', Type: 'TXT', Value: 'target' }],
  }))
  assert.equal(
    await new TencentCloudDNS('id', 'key').findResourceRecordId('example.com', '_acme-challenge', 'target'),
    101,
  )
  assert.deepEqual(
    describe.mock.calls.map((call) => call.arguments[0]?.Offset),
    [0, 100],
  )
  assert.equal(describe.mock.calls[0]?.arguments[0]?.ErrorOnEmpty, 'no')
})

test('never deletes a matching record when the API omits its record ID', async (t) => {
  t.mock.method(console, 'error', () => {})
  t.mock.method(Client.prototype, 'DescribeDomainList', async () => ({ DomainList: [{ Name: 'example.com' }] }))
  t.mock.method(Client.prototype, 'DescribeRecordList', async () => ({
    RecordList: [{ Name: '_acme-challenge', Type: 'TXT', Value: 'validation-root' }],
  }))
  const remove = t.mock.method(Client.prototype, 'DeleteRecord', async () => ({}))
  await assert.rejects(runCleanup(new TencentCloudDNS('id', 'key'), readConfig(environment, false)), /valid RecordId/)
  assert.equal(remove.mock.callCount(), 0)
})

test('cleanup is a no-op when the zone or validation record is absent', async (t) => {
  t.mock.method(console, 'error', () => {})
  const describe = t.mock.method(Client.prototype, 'DescribeDomainList', async () => ({ DomainList: [] }))
  const findRecord = t.mock.method(Client.prototype, 'DescribeRecordList', async () => ({ RecordList: [] }))
  const remove = t.mock.method(Client.prototype, 'DeleteRecord', async () => ({}))
  const api = new TencentCloudDNS('id', 'key')
  await runCleanup(api, readConfig(environment, false))
  assert.equal(findRecord.mock.callCount(), 0)
  describe.mock.mockImplementation(async () => ({ DomainList: [{ Name: 'example.com' }] }))
  await runCleanup(api, readConfig(environment, false))
  assert.equal(remove.mock.callCount(), 0)
})

test('an empty record list is a no-op while API and deletion failures propagate', async (t) => {
  const describe = t.mock.method(Client.prototype, 'DescribeRecordList', async () => {
    throw Object.assign(new Error('empty'), { code: 'ResourceNotFound.NoDataOfRecord' })
  })
  const api = new TencentCloudDNS('id', 'key')
  assert.equal(await api.findResourceRecordId('example.com', '_acme-challenge', 'value'), null)
  describe.mock.mockImplementation(async () => {
    throw new Error('UnauthorizedOperation')
  })
  await assert.rejects(api.findResourceRecordId('example.com', '_acme-challenge', 'value'), /UnauthorizedOperation/)
  t.mock.method(console, 'error', () => {})
  t.mock.method(Client.prototype, 'DescribeDomainList', async () => ({ DomainList: [{ Name: 'example.com' }] }))
  describe.mock.mockImplementation(async () => ({
    RecordList: [{ RecordId: 1, Name: '_acme-challenge', Type: 'TXT', Value: 'validation-root' }],
  }))
  t.mock.method(Client.prototype, 'DeleteRecord', async () => {
    throw new Error('DeleteRecord denied')
  })
  await assert.rejects(runCleanup(api, readConfig(environment, false)), /DeleteRecord denied/)
})

test('CLI hooks report configuration failures with a nonzero exit and no credentials', () => {
  for (const hook of ['auth', 'cleanup']) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL(`../src/${hook}.ts`, import.meta.url))],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          TENCENTCLOUD_SECRET_ID: 'do-not-print-this',
          TENCENTCLOUD_SECRET_KEY: '',
          CERTBOT_DOMAIN: '',
          CERTBOT_VALIDATION: '',
          DOTENV_CONFIG_PATH: 'nonexistent-test.env',
        },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Missing required environment variables/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /do-not-print-this/)
  }
})
