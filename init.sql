-- GitHub Backup Worker 数据库结构
-- 线上实际使用的表：backups
-- 本文件用于从零初始化 D1（本地 dev 或全新环境）

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL,              -- 'success' | 'failed'
  error_msg TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  file_size INTEGER DEFAULT 0
);

-- 1) cleanupOldBackups：WHERE repo_name=? AND branch=? AND status=? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_backups_repo_branch_status_created
  ON backups(repo_name, branch, status, created_at DESC);

-- 2) 下载/删除归属校验：WHERE file_name=? AND status='success'
CREATE INDEX IF NOT EXISTS idx_backups_file_name
  ON backups(file_name);

-- 3) /api/logs 列表：ORDER BY created_at DESC LIMIT 50
CREATE INDEX IF NOT EXISTS idx_backups_created
  ON backups(created_at DESC);
