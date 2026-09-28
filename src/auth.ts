#!/usr/bin/env node
import dotenv from 'dotenv'
import { readConfig, reportError, runAuth } from './hooks.js'
import { TencentCloudDNS } from './tencent-cloud-dns.js'

dotenv.config()

try {
  const config = readConfig(process.env, true)
  await runAuth(new TencentCloudDNS(config.secretId, config.secretKey, config.token), config)
} catch (error) {
  reportError('Auth', error)
}
