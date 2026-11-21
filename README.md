# GitHub Backup Worker

基于 Cloudflare Workers 的零服务器 GitHub 仓库备份方案。GitHub Webhook 触发后，Worker 拉取仓库 tarball 并存入 R2，元数据记录在 D1，内置管理面板可查看日志、下载历史备份、删除归档。

## 架构

- **Cloudflare Worker**：接收 GitHub Webhook、拉取 tarball、写 R2/D1、托管管理页
- **R2**：存储 `.tar.gz` 备份文件
- **D1**：存储备份记录（`backups` 表：仓库、分支、文件名、大小、状态、时间）
- **GitHub Webhook**：仓库 push 时触发，HMAC-SHA256 签名校验

## 功能

- ✅ GitHub Webhook 触发自动备份（HMAC-SHA256 签名校验）
- ✅ 流式上传 R2（`FixedLengthStream`，大仓库不 OOM）
- ✅ 备份保留策略可配置（按仓库+分支统计，成功/失败分开清理）
- ✅ 内置管理面板：日志列表、仓库筛选、下载、删除（Cookie 会话认证）
- ✅ 失败记录也落库，且支持手动清理
- ✅ 纯 Cloudflare 免费额度内可运行（R2 10GB / D1 5GB / Worker 10 万请求/天）

## 项目结构

```text
github-backup-worker/
├── wrangler.toml      # Wrangler 配置（D1/R2 绑定、自定义域名路由）
├── init.sql           # D1 初始化脚本（backups 表 + 索引）
├── src/
│   └── index.js       # Worker 核心逻辑（路由、备份、管理面板、API）
├── .env.example       # 本地开发环境变量示例
├── .gitignore
├── LICENSE            # MIT
└── README.md
```

## 前置条件

- Cloudflare 账号（免费版即可）
- Node.js 18+
- GitHub Personal Access Token（fine-grained，仅需目标仓库 `Contents: Read`）

## 部署步骤

### 1. 克隆项目到本地并安装依赖

```bash
git clone https://github.com/ycscg/github-backup-worker.git
cd github-backup-worker
```

### 2. 登录 Wrangler

```bash
npx wrangler login
```

### 3. 创建 R2 桶和 D1 数据库

```bash
npx wrangler r2 bucket create github-backup-bucket
npx wrangler d1 create github-backup-db
```

### 4. 修改配置文件（⚠️ 最重要的一步）

在终端中创建了 R2 桶和 D1 数据库后，你必须修改 `wrangler.toml` 文件，将资源绑定到你自己的 Cloudflare 账号下。如果不修改，后续部署一定会失败。

使用文本编辑器（或 VS Code）打开根目录下的 `wrangler.toml`，你需要修改以下三个地方：

**① 修改 D1 数据库 ID**

找到 `[[d1_databases]]` 这一段：

```toml
[[d1_databases]]
binding = "DB"
database_name = "github-backup-db"
database_id = "66666f4a-d0f9-486d-8541-137199dd8468"   # 替换为你自己的 ID
```

👉 怎么找？执行 `npx wrangler d1 list`，找到你刚创建的 `github-backup-db`，复制对应的 uuid 替换掉双引号里的内容。

**② 修改 R2 存储桶名称**

找到 `[[r2_buckets]]` 这一段：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "github-backup-bucket"   # 替换为你自己的桶名
```

👉 怎么找？执行 `npx wrangler r2 bucket list`，找到你创建的桶名并替换（如果你完全照抄了上面的创建命令，这里就是 `github-backup-bucket`，不用改）。

**③ 修改自定义域名路由（或注释掉）**

找到 `routes` 这一段：

```toml
routes = [
  { pattern = "fkgit.ai99cn.com/*", zone_name = "ai99cn.com" }
]
```

👉 注意：

- 如果你没有自己的域名，必须在 `routes = [`、`{ pattern...}`、`]` 这三行前面加上 `#` 号注释掉。否则部署时会报错"找不到该域名"。
- 如果你有绑定自己的域名，请将其修改为你自己的「子域名」和「主域名」。

### 5. 初始化 D1 表结构

```bash
npx wrangler d1 execute github-backup-db --remote --file=./init.sql
```

`init.sql` 会创建 `backups` 表及三个索引。

### 6. 设置 Secret

```bash
npx wrangler secret put GITHUB_TOKEN      # GitHub PAT
npx wrangler secret put WEBHOOK_SECRET    # 自行生成随机串，与 GitHub Webhook 配置一致
npx wrangler secret put ADMIN_PASSWORD    # 管理面板密码
```

### 7. 部署

```bash
npx wrangler deploy
```

部署后得到 `https://github-backup-worker.<你的子域>.workers.dev`。如需绑定自定义域名，在 Cloudflare 控制台为 Worker 绑定 Custom Domain，并修改 `wrangler.toml` 的 `routes` 为你的域名后重新 `deploy`。

### 8. 配置 GitHub Webhook

你有两种方式配置 Webhook 触发备份：

**方式 A：仓库级配置（适合少量仓库）**

目标仓库 → Settings → Webhooks → Add webhook：

- **Payload URL**：`https://<你的Worker地址>/webhook`
- **Content type**：`application/json`
- **Secret**：与 `WEBHOOK_SECRET` 一致
- **Events**：Just the push event

**方式 B：组织级配置（推荐，适合多仓库批量备份）**

如果你有多个仓库需要备份，强烈建议将它们转移到一个 GitHub Organization（组织）下，然后配置组织级 Webhook：

1. 进入你的 GitHub Organization 页面 → Settings → Webhooks → Add webhook。
2. 填写相同的 Payload URL、Content type 和 Secret。
3. 触发事件选择 Just the push event 并保存。

配置完成后，该组织下的所有仓库（包括未来新建的）在 push 时都会自动触发备份，无需再逐个仓库设置。

## 使用

访问 Worker 根路径，输入 `ADMIN_PASSWORD` 登录，进入管理面板：

- 查看备份日志（支持按仓库名称下拉筛选，防止看错）
- 下载成功备份（`.tar.gz`）
- 删除备份（同时删 R2 文件和 D1 记录，失败记录也支持手动清理）

## 环境变量

| 名称 | 类型 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | Secret | GitHub PAT，拉取 tarball 用 |
| `WEBHOOK_SECRET` | Secret | Webhook HMAC 校验密钥 |
| `ADMIN_PASSWORD` | Secret | 管理面板密码 |
| `BACKUP_RETAIN_COUNT` | Var | 每个 (repo, branch) 保留成功备份数，默认 5 |
| `BACKUP_FAILED_RETAIN_COUNT` | Var | 每个 (repo, branch) 保留失败记录数，默认 5 |

## 本地开发

```bash
cp .env.example .dev.vars   # 填入真实值
npx wrangler dev
```

`.dev.vars` 已被 `.gitignore` 忽略。

## 已知限制

- 只处理 `refs/heads/*` 的 push 事件，不处理 tag、分支删除
- 无定时全量备份（仅 webhook 触发；如需定时，需自行实现 `scheduled` 处理器）
- Worker 单次请求有 CPU 时长上限，超大仓库可能超时
- 备份是 GitHub 提供的 tarball 快照，非完整 Git 仓库（无 `.git` 历史）

## License

MIT
