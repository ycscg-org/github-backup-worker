-- 创建仓库元数据表
CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT DEFAULT 'main',
    last_commit_sha TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1,
    UNIQUE(owner, repo)
);

-- 创建同步日志表
CREATE TABLE IF NOT EXISTS sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    commit_sha TEXT,
    status TEXT NOT NULL, -- 'success', 'failed', 'skipped'
    message TEXT,
    r2_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引以加速查询
CREATE INDEX IF NOT EXISTS idx_repo_owner_repo ON repositories(owner, repo);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON sync_logs(created_at);

