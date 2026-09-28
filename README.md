# tencent-cloud-certbot-dns-hook

使用 TypeScript 和[腾讯云官方 DNSPod SDK](https://github.com/TencentCloud/tencentcloud-sdk-nodejs)，为 Certbot 提供 DNS-01 验证和清理钩子。

支持主域名、多级子域名和泛域名。脚本自动查找账号中最具体的 DNSPod 托管域名，创建 `_acme-challenge` TXT 记录，默认等待 60 秒后交给 Certbot 验证；清理时仅删除名称、类型和本次 `CERTBOT_VALIDATION` 值都匹配的默认线路 TXT 记录。

## 准备

- Node.js 20 或更新版本、pnpm，以及已安装的 Certbot。
- 域名已经添加到腾讯云 DNSPod，且权威 DNS 已指向 DNSPod。域名仅在腾讯云注册、但解析由其他服务商托管时无法使用本项目。
- [腾讯云 API 密钥](https://console.cloud.tencent.com/cam/capi)：SecretId 和 SecretKey。这里使用腾讯云云 API 凭证。
- 凭证需要允许 `dnspod:DescribeDomainList`、`dnspod:DescribeRecordList`、`dnspod:CreateRecord` 和 `dnspod:DeleteRecord` 操作。

## 安装

本地源码安装：

```sh
pnpm install
pnpm run build:all
```

构建后可以通过项目内的 `auth.cmd` / `cleanup.cmd`（Windows）或 `auth.sh` / `cleanup.sh`（Linux）调用钩子。

如果需要安装全局命令，可以在项目目录执行：

```sh
npm install -g .
```

会安装两个命令：

- `lsby-tencent-cloud-certbot-dns-hook-auth`
- `lsby-tencent-cloud-certbot-dns-hook-cleanup`

## 配置

| 环境变量                               | 用途                                             |
| -------------------------------------- | ------------------------------------------------ |
| `TENCENTCLOUD_SECRET_ID`               | 必填，腾讯云 SecretId                            |
| `TENCENTCLOUD_SECRET_KEY`              | 必填，腾讯云 SecretKey                           |
| `TENCENTCLOUD_TOKEN`                   | 可选，使用临时凭证时的 Token                     |
| `TENCENTCLOUD_DNS_PROPAGATION_SECONDS` | 可选，新增 TXT 后等待的秒数，默认 `60`；非负整数 |
| `CERTBOT_DOMAIN`                       | Certbot 自动传入的待验证域名                     |
| `CERTBOT_VALIDATION`                   | Certbot 自动传入的 TXT 验证值，验证和清理均使用  |

也支持从**当前工作目录**的 `.env` 读取变量，可以复制 `.env.example` 后填写。系统环境变量优先于 `.env`。Certbot 在其他目录启动时，建议把凭证设置在它继承的环境中，或写在你自己的钩子包装脚本中。

### Windows

从 CMD 执行，先设置凭证，钩子会继承这些变量：

```batch
set "TENCENTCLOUD_SECRET_ID=你的SecretId"
set "TENCENTCLOUD_SECRET_KEY=你的SecretKey"

certbot certonly --manual --non-interactive --preferred-challenges=dns --manual-auth-hook "D:\Code\tencent-cloud-cerboot-dns-hook\auth.cmd" --manual-cleanup-hook "D:\Code\tencent-cloud-cerboot-dns-hook\cleanup.cmd" --agree-tos -m "you@example.com" -d "www.example.com"
```

PowerShell 设置环境变量的写法是：

```powershell
$env:TENCENTCLOUD_SECRET_ID = '你的SecretId'
$env:TENCENTCLOUD_SECRET_KEY = '你的SecretKey'
```

若通过计划任务自动续期，确保该任务也能获得凭证。也可以创建自己的包装脚本：

`my-auth.cmd`：

```batch
@echo off
set "TENCENTCLOUD_SECRET_ID=你的SecretId"
set "TENCENTCLOUD_SECRET_KEY=你的SecretKey"
node "D:\Code\tencent-cloud-cerboot-dns-hook\dist\auth.js"
```

`my-cleanup.cmd` 使用相同凭证，最后一行替换为 `node "D:\Code\tencent-cloud-cerboot-dns-hook\dist\cleanup.js"`。将 Certbot 的钩子路径指向这两个文件即可。

### Linux

```sh
export TENCENTCLOUD_SECRET_ID='你的SecretId'
export TENCENTCLOUD_SECRET_KEY='你的SecretKey'
chmod +x /path/to/tencent-cloud-certbot-dns-hook/auth.sh /path/to/tencent-cloud-certbot-dns-hook/cleanup.sh

certbot certonly --manual --non-interactive --preferred-challenges=dns \
  --manual-auth-hook /path/to/tencent-cloud-certbot-dns-hook/auth.sh \
  --manual-cleanup-hook /path/to/tencent-cloud-certbot-dns-hook/cleanup.sh \
  --agree-tos -m 'you@example.com' -d 'www.example.com'
```

如果使用 `sudo certbot`，请确保凭证也传入该进程的环境中。

### 泛域名证书

将上面的 `-d "www.example.com"` 替换为：

```sh
-d "*.example.com" -d "example.com"
```

泛域名必须加引号，避免 shell 展开星号。`*.example.com` 不包含根域名 `example.com`，因此推荐一起申请。两次挑战可以共用 `_acme-challenge.example.com`，清理时按各自的验证值匹配。

## 续期与排查

使用已经保存的钩子配置续期：

```sh
certbot renew
```

续期进程需要能访问原来的钩子文件，并获得相同的 API 凭证。可先运行 `certbot renew --dry-run` 检查配置。

- DNS 验证失败时，可以将 `TENCENTCLOUD_DNS_PROPAGATION_SECONDS` 调整为 `120` 或更长。固定等待时间不保证传播完成。
- TXT 记录使用默认线路，TTL 由 DNSPod 的默认值决定，以兼容不同域名套餐。项目没有实现 CNAME 验证委托；实际验证记录应直接托管在匹配的 DNSPod 域名下。
- 钩子缺少必填变量或 API 调用失败时以非零状态退出，日志写入 stderr；不会把鉴权、网络或权限错误当作“没有记录”。
- 凭证不要提交到版本库；`.env` 已加入忽略列表。

## 开发验证

```sh
pnpm run other:typecheck
pnpm test
pnpm run build:all
```

测试使用模拟 SDK，覆盖域名和记录分页、多级子域名、根域名与泛域名共存时的精确清理，以及配置和 API 错误处理，不访问真实账号。

接口参考：[创建记录](https://cloud.tencent.com/document/api/1427/56180)、[查询记录](https://cloud.tencent.com/document/api/1427/56166)、[删除记录](https://cloud.tencent.com/document/api/1427/56176)。
