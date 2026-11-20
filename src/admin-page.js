export function getAdminPage() {
  return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>GitHub Backup Manager</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f6f8fa; }
        .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #24292e; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input[type="text"], input[type="password"] { width: 100%; padding: 8px; border: 1px solid #d0d7de; border-radius: 4px; box-sizing: border-box; }
        button { background-color: #2da44e; color: white; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; font-size: 14px; }
        button:hover { background-color: #2c974b; }
        button.secondary { background-color: #0969da; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #d0d7de; padding: 8px; text-align: left; }
        th { background-color: #f6f8fa; }
        .status-success { color: green; }
        .status-failed { color: red; }
        #login-section, #admin-section { display: none; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📦 GitHub Backup Manager</h1>
        
        <!-- 登录部分 -->
        <div id="login-section">
            <div class="form-group">
                <label>管理员密码</label>
                <input type="password" id="admin-password" placeholder="输入密码">
            </div>
            <button onclick="login()">登录</button>
        </div>

        <!-- 管理面板部分 -->
        <div id="admin-section">
            <h2>添加仓库</h2>
            <div class="form-group">
                <label>Owner (用户名或组织)</label>
                <input type="text" id="repo-owner" placeholder="例如: cloudflare">
            </div>
            <div class="form-group">
                <label>Repo (仓库名)</label>
                <input type="text" id="repo-name" placeholder="例如: workers-rs">
            </div>
            <div class="form-group">
                <label>Branch (分支)</label>
                <input type="text" id="repo-branch" value="main">
            </div>
            <button onclick="addRepo()">添加并同步</button>
            <button class="secondary" onclick="syncAll()">一键全量同步</button>

            <h2>最近同步日志</h2>
            <table id="log-table">
                <thead>
                    <tr>
                        <th>时间</th>
                        <th>仓库</th>
                        <th>状态</th>
                        <th>消息</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
            
            <h2>已备份仓库列表</h2>
            <table id="repo-table">
                <thead>
                    <tr>
                        <th>Owner</th>
                        <th>Repo</th>
                        <th>最后同步</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
    </div>

    <script>
        const API_BASE = '/api';
        let authToken = localStorage.getItem('auth_token');

        async function login() {
            const password = document.getElementById('admin-password').value;
            try {
                const res = await fetch(\`\${API_BASE}/login\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                if (res.ok) {
                    const data = await res.json();
                    authToken = data.token;
                    localStorage.setItem('auth_token', authToken);
                    showAdminPanel();
                } else {
                    alert('密码错误');
                }
            } catch (e) {
                alert('登录失败: ' + e.message);
            }
        }

        async function showAdminPanel() {
            if (!authToken) {
                document.getElementById('login-section').style.display = 'block';
                document.getElementById('admin-section').style.display = 'none';
                return;
            }
            document.getElementById('login-section').style.display = 'none';
            document.getElementById('admin-section').style.display = 'block';
            loadLogs();
            loadRepos();
        }

        async function addRepo() {
            const owner = document.getElementById('repo-owner').value;
            const repo = document.getElementById('repo-name').value;
            const branch = document.getElementById('repo-branch').value;
            
            if (!owner || !repo) return alert('请填写完整信息');

            try {
                const res = await fetch(\`\${API_BASE}/repos\`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': \`Bearer \${authToken}\`
                    },
                    body: JSON.stringify({ owner, repo, branch })
                });
                if (res.ok) {
                    alert('添加成功，开始同步...');
                    loadRepos();
                    loadLogs();
                } else {
                    const err = await res.text();
                    alert('添加失败: ' + err);
                }
            } catch (e) {
                alert('网络错误: ' + e.message);
            }
        }

        async function syncAll() {
            if (!confirm('确定要立即同步所有仓库吗？')) return;
            try {
                const res = await fetch(\`\${API_BASE}/sync-all\`, {
                    method: 'POST',
                    headers: { 'Authorization': \`Bearer \${authToken}\` }
                });
                if (res.ok) alert('同步任务已触发');
                else alert('触发失败');
            } catch (e) {
                alert('错误: ' + e.message);
            }
        }

        async function loadLogs() {
            try {
                const res = await fetch(\`\${API_BASE}/logs\`, {
                    headers: { 'Authorization': \`Bearer \${authToken}\` }
                });
                const logs = await res.json();
                const tbody = document.querySelector('#log-table tbody');
                tbody.innerHTML = logs.map(log => \`
                    <tr>
                        <td>\${new Date(log.created_at).toLocaleString()}</td>
                        <td>\${log.owner}/\${log.repo}</td>
                        <td class="status-\${log.status}">\${log.status}</td>
                        <td>\${log.message || '-'}</td>
                    </tr>
                \`).join('');
            } catch (e) { console.error(e); }
        }

        async function loadRepos() {
            try {
                const res = await fetch(\`\${API_BASE}/repos\`, {
                    headers: { 'Authorization': \`Bearer \${authToken}\` }
                });
                const repos = await res.json();
                const tbody = document.querySelector('#repo-table tbody');
                tbody.innerHTML = repos.map(repo => \`
                    <tr>
                        <td>\${repo.owner}</td>
                        <td>\${repo.repo}</td>
                        <td>\${new Date(repo.last_synced_at).toLocaleString()}</td>
                        <td><button onclick="deleteRepo(\${repo.id})" style="background:red;padding:5px;">删除</button></td>
                    </tr>
                \`).join('');
            } catch (e) { console.error(e); }
        }

        async function deleteRepo(id) {
            if (!confirm('确定删除此仓库备份配置？')) return;
            try {
                await fetch(\`\${API_BASE}/repos/\${id}\`, {
                    method: 'DELETE',
                    headers: { 'Authorization': \`Bearer \${authToken}\` }
                });
                loadRepos();
            } catch (e) { alert('删除失败'); }
        }

        // 初始化检查
        showAdminPanel();
    </script>
</body>
</html>
  `, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
  });
}

