# GitHub Backup Worker

一套基于 Cloudflare Workers 的零服务器 GitHub 仓库自动备份方案。仓库 push 时由 GitHub Webhook 唤起 Worker 拉取 tarball 存入 R2，备份记录写入 D1；内置管理面板可查看日志、手动备份单个仓库或整个组织、下载与删除历史备份，并带实时进度反馈和 R2 空间熔断保护。

## 架构

- **GitHub Webhook**：仓库 push 时触发，HMAC-SHA256 签名校验
- **Cloudflare Worker**：接收 Webhook、拉取 tarball、写 R2/D1、托管管理页
- **R2**：存储 `.tar.gz` 备份文件
- **D1**：`backups` 表存备份记录（仓库、分支、文件名、大小、状态、错误信息、时间），`settings` 表存面板设置（`r2_max_gb` 空间上限、`backup_paused` 熔断状态）
- **KV**：暂存单库备份（`manual_backup_result`）与全量备份（`sync_result`）的进度和结果，供管理页轮询实时展示

## 功能

- ✅ GitHub Webhook 触发自动备份（HMAC-SHA256 签名校验）
- ✅ 流式上传 R2（`FixedLengthStream`，大仓库不 OOM；GitHub 未返回 Content-Length 时自动回退为缓冲上传）
- ✅ 内置管理面板：日志列表、按仓库筛选、下载、删除（Cookie 会话认证，有效期 24 小时）
- ✅ 手动备份单库：提交前校验仓库是否存在，分支留空时自动识别仓库默认分支（main / master / develop 等）
- ✅ 单库备份实时反馈：后台任务完成后页面立即弹窗提示成功（含分支、文件大小）或具体失败原因，无需退出重登
- ✅ 全量备份组织：对比 `pushed_at` 自动跳过无更新的仓库，单次处理数量可调，完成后弹窗汇总成功 / 失败 / 跳过数量
- ✅ R2 空间熔断保护：占用超过设定上限时先自动清理冗余旧备份（每个仓库仅保留最新一条），仍不足则暂停全部备份，页面顶部显示红色横幅，清理空间后可一键恢复
- ✅ 备份保留策略：每个 (仓库, 分支) 保留最近 5 条成功备份
- ✅ 失败记录同样落库，支持手动清理
- ✅ 纯 Cloudflare 免费额度内可运行（R2 10GB / D1 5GB / KV 1000 次写/天 / Worker 10 万请求/天）

## 项目结构

```text
github-backup-worker/
├── wrangler.toml      # Wrangler 配置（D1/R2/KV 绑定、自定义域名路由）
├── init.sql           # D1 初始化脚本（backups 表、settings 表及索引）
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
- GitHub Personal Access Token（**classic** 类型，勾选 `repo` scope；若仅备份公开仓库，勾 `public_repo` 也可）

## 部署步骤

### 1. 克隆项目到本地

```bash
git clone https://github.com/ycscg-org/github-backup-worker.git
cd github-backup-worker
```

项目使用 `npx wrangler` 直接运行，无需手动安装依赖（如仓库提供了 `package.json`，也可先执行 `npm install`）。

### 2. 登录 Wrangler

```bash
npx wrangler login
```

### 3. 创建 Cloudflare 资源

```bash
npx wrangler r2 bucket create github-backup-bucket
npx wrangler d1 create github-backup-db
npx wrangler kv namespace create bakgit-status-kv
```

- `d1 create` 会输出 `database_id`，填入 `wrangler.toml`。
- `kv namespace create` 会输出 KV 的 `id`，填入 `wrangler.toml`（注：Wrangler 自动生成的 binding 是 `bakgit_status_kv`，但代码里使用的是 `KV`，请在配置时手动将 binding 改为 `KV`）。

### 4. 修改配置文件（⚠️ 最重要的一步）

在终端中创建了 R2 桶、D1 数据库和 KV 命名空间后，你必须修改 `wrangler.toml` 文件，将资源绑定到你自己的 Cloudflare 账号下。如果不修改，后续部署一定会失败。

使用文本编辑器（或 VS Code）打开根目录下的 `wrangler.toml`，你需要修改以下四个地方：

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

- 这里“ai99cn.com”是作者自用域名，如果你在 Cloudflare 有自己的域名，请将其修改为你自己的「子域名」和「主域名」。
- 如果你没有自己的域名，必须在 `routes = [`、`{ pattern...}`、`]` 这三行前面加上 `#` 号注释掉。否则部署时会报错"找不到该域名"。

**④ 修改 KV 命名空间 ID**

找到 `[[kv_namespaces]]` 这一段（如果没有则手动添加）：

```toml
[[kv_namespaces]]
binding = "KV"
id = "7109ce428e324caa821c8bd2722a236b" # 替换为你刚才创建的 KV ID
```

👉 注意：binding 必须写为 `"KV"`，不要修改，否则代码里 `env.KV` 会报错。

### 5. 初始化 D1 表结构

```bash
npx wrangler d1 execute github-backup-db --remote --file=./init.sql
```

`init.sql` 需要创建两张表：

- `backups`：备份记录（`repo_name`、`branch`、`file_name`、`file_size`、`status`、`error_msg`、`created_at`）及其索引
- `settings`：面板设置（`r2_max_gb`、`backup_paused`）

⚠️ `settings` 表是备份功能正常运行的必要项——每次备份都会读取其中的 R2 空间上限。如果你手上的 `init.sql` 是早期版本、只创建了 `backups` 表，请补建：

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

### 6. 设置 Secret

本项目需要三个 Secret：`GITHUB_TOKEN`、`WEBHOOK_SECRET`、`ADMIN_PASSWORD`。三个值都通过 `wrangler secret put` 逐条写入，执行后终端会提示 `Enter a secret value:`，粘贴内容后回车即可（输入过程不回显）。重复执行同名命令会直接覆盖旧值。

#### 6.1 生成一个 GitHub PAT（classic）

`GITHUB_TOKEN` 是让 Worker 能够顺利拉取代码的关键凭证，主要有两个作用：
1. **突破 API 限流**：未认证的请求每小时只能请求 60 次，认证后可达 5000 次/小时。如果不配 Token，进行“组织全量备份”时会极易触发限流导致大批量失败。
2. **读取私有仓库**：虽然是备份公开仓库无需 Token 也能拉取，但如果你想备份**自己的私有仓库**，或者你作为协作者有权限访问的他人私有仓库，必须通过 Token 提供授权。

GitHub 有两类 Token：Fine-grained 与 classic。本项目**不使用 Fine-grained Token**——它一次只能授权一个 resource owner（你本人或某一个组织）名下的仓库，跨组织或批量备份时需要逐个生成、容易漏掉仓库，批量下载容易出现遗漏；因此统一使用 **Personal access tokens (classic)**，一份 `repo` scope 即可覆盖账号下可访问的全部仓库。

生成步骤：

1. 登录 GitHub，点击右上角头像 → **Settings**。
2. 左侧栏拉到底部，点击 **Developer settings**。
3. 选择 **Personal access tokens** → **Tokens (classic)** → 点击 **Generate new token (classic)**。
4. 填写 **Note**（备注，如 `github-backup-worker`），并设置 **Expiration**（建议 90 天；下拉里也能选 No expiration，但不推荐）。
5. **Select scopes**：勾选 **repo**（本项目只需读取仓库内容，classic 没有更细的只读选项，勾 `repo` 即可；若仅备份公开仓库，勾 `public_repo` 也够用）。
6. 点击底部的 **Generate token**，页面会显示一串以 `ghp_` 开头的 Token，**该 Token 只显示一次，请立即复制保存**。
7. 如果该 Token 需要访问启用了 SAML SSO 的组织，生成后还要在 Token 列表里点击 **Configure SSO** → **Authorize** 完成授权，否则访问该组织的私有仓库会返回 404。

拿到 Token 后写入 Secret：

```bash
npx wrangler secret put GITHUB_TOKEN      # 粘贴上一步生成的 ghp_xxx
```

#### 6.2 生成随机串作为 WEBHOOK_SECRET

`WEBHOOK_SECRET` 用于校验 GitHub Webhook 的 HMAC-SHA256 签名，需要一串足够随机的字符串。用下面的命令生成（任选其一，在本地终端执行）：

```bash
# 方式一：openssl（macOS/Linux 自带）
openssl rand -hex 32

# 方式二：Node.js（已装 Node 时可用）
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

复制命令输出的随机串，写入 Secret：

```bash
npx wrangler secret put WEBHOOK_SECRET    # 粘贴上一步生成的随机串，务必与 GitHub Webhook 里的 Secret 保持一致
```

#### 6.3 设置管理面板密码 ADMIN_PASSWORD

`ADMIN_PASSWORD` 是管理面板的登录密码，可自定义为任意你方便记忆又不易被猜到的字符串（建议包含大小写字母、数字，长度 12 位以上）。

```bash
npx wrangler secret put ADMIN_PASSWORD    # 自定义你的管理面板密码，自行记住用于登录
```

#### 6.4 一键写入（可选）

以下三条命令对应上面 6.1–6.3，也可以连续执行：

```bash
npx wrangler secret put GITHUB_TOKEN      # GitHub PAT
npx wrangler secret put WEBHOOK_SECRET    # 自行生成随机串，与 GitHub Webhook 配置一致
npx wrangler secret put ADMIN_PASSWORD    # 管理面板密码
```

### 7. 部署

```bash
npx wrangler deploy
```

（如果你之前执行过 npm install，也可以简写为 npm run deploy）

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

访问 Worker 根路径，输入 `ADMIN_PASSWORD` 登录进入管理面板。

**日志列表**

- 按仓库名称下拉筛选，避免看错
- 成功记录可「下载」（`.tar.gz`）或「删除」；删除会同时清除 R2 文件与 D1 记录，失败记录也支持手动清理

**手动备份单库**

1. 填写 `owner/repo`，分支可留空；留空时自动识别该仓库的默认分支
2. 点击「开始备份」后，会先校验仓库是否存在，拼写错误或分支不存在会立即弹窗提示
3. 提交成功后按钮显示实际使用的分支，后台完成时弹窗提示结果并自动刷新下面的日志列表

**全量备份组织**

1. 填写组织名，设置「单次最多备份」数量（默认 10，范围 1–100）
2. 系统自动跳过最近备份时间晚于仓库 `pushed_at` 的仓库，只补齐有更新的
3. 完成后弹窗汇总本次成功、失败、跳过数量

**系统设置**

- 「R2 最大可用空间」：设定可用于备份的空间上限（GB）。若多个 Worker 共用同一个 R2 桶，请扣除其他项目占用的空间
- 空间不足触发熔断时，页面顶部出现红色横幅，清理旧备份腾出空间后点击「恢复备份」即可解除

## 环境变量

Secret 通过 `wrangler secret put` 设置，Var 在 `wrangler.toml` 的 `[vars]` 中修改。

| 名称 | 类型 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | Secret | GitHub PAT，拉取 tarball 用 |
| `WEBHOOK_SECRET` | Secret | Webhook HMAC 校验密钥 |
| `ADMIN_PASSWORD` | Secret | 管理面板密码 |
| `BACKUP_RETAIN_COUNT` | Var | 每个 (仓库, 分支) 保留的成功备份数 |
| `BACKUP_FAILED_RETAIN_COUNT` | Var | 每个 (仓库, 分支) 保留的失败记录数 |

> 提示：当前版本的成功备份保留数量由 `src/index.js` 顶部的常量 `BACKUP_RETAIN_COUNT = 5` 决定，`wrangler.toml` 中的同名 Var 尚未被代码读取，失败记录也暂未参与自动清理。如需调整保留数量，请直接修改该常量。

## 本地开发

```bash
cp .env.example .dev.vars   # 填入真实值
npx wrangler dev
```

`.dev.vars` 已被 `.gitignore` 忽略。

## 已知限制

- 只处理 `refs/heads/*` 的 push 事件，不处理 tag、分支删除
- 无定时全量备份（仅 Webhook 触发；如需定时，需自行实现 `scheduled` 处理器）
- Worker 单次请求有 CPU 时长上限，超大仓库可能超时
- 备份是 GitHub 提供的 tarball 快照，非完整 Git 仓库（无 `.git` 历史）

## License

MIT
