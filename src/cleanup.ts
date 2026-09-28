#!/usr/bin/env node
import dotenv from 'dotenv'
import { readConfig, reportError, runCleanup } from './hooks.js'
import { TencentCloudDNS } from './tencent-cloud-dns.js'

dotenv.config()

try {
  const config = readConfig(process.env, false)
  await runCleanup(new TencentCloudDNS(config.secretId, config.secretKey, config.token), config)
} catch (error) {
  reportError('Cleanup', error)
}
