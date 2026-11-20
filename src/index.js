var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "POST") {
      return await handleWebhook(request, env, ctx);
    }
    if (url.pathname === "/" || url.pathname === "/admin") {
      return await handleAdminUI(request, env);
    }
    if (url.pathname === "/api/logs" && request.method === "GET") {
      return await handleGetLogs(request, env);
    }
    return new Response("Not Found", { status: 404 });
  }
};
async function handleWebhook(request, env, ctx) {
  try {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (body.ref && body.repository) {
      const ref = body.ref;
      const branch = ref.replace('refs/heads/', '');
      const repoName = body.repository.name;
      const owner = body.repository.owner.login;
      const cloneUrl = body.repository.clone_url; 
      
      console.log(`Triggering backup for ${owner}/${repoName} on branch ${branch}`);

      // 关键：确保 waitUntil 包裹的是 Promise，且不会阻塞主响应
      ctx.waitUntil(performBackup(env, owner, repoName, branch, cloneUrl));

      // 立即返回 200，不要等待 performBackup 完成
      return new Response('Backup triggered', { status: 200 });
    } else {
      return new Response('OK', { status: 200 });
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    // 即使出错，也返回一个明确的错误响应，而不是让连接挂起
    return new Response('Internal Server Error: ' + e.message, { status: 500 });
  }
}

__name(handleWebhook, "handleWebhook");
async function performBackup(env, owner, repoName, branch, cloneUrl) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const fileName = `${owner}-${repoName}-${branch}-${timestamp}.tar.gz`;
  let status = "failed";
  let errorMsg = "";
  try {
    if (!env.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN is not configured in secrets");
    }
    if (!env.BUCKET) {
      throw new Error("R2 BUCKET binding is missing");
    }
    const tarballUrl = `https://api.github.com/repos/${owner}/${repoName}/tarball/refs/heads/${branch}`;

const response = await fetch(tarballUrl, {
  headers: {
    'Authorization': `token ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'github-backup-worker-cloudflare'
  }
});
    if (!response.ok) {
      throw new Error(`GitHub API Error: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    await env.BUCKET.put(fileName, uint8Array, {
      httpMetadata: {
        contentType: "application/gzip"
      }
    });
    status = "success";
    console.log(`Backup successful: ${fileName}`);
  } catch (e) {
    status = "failed";
    errorMsg = e.message;
    console.error(`Backup failed for ${repoName}: Error message -> ${errorMsg}`);
    console.error(`Full error stack:`, e.stack || "No stack trace");
  } finally {
    try {
      if (env.DB) {
        await env.DB.prepare(
          "INSERT INTO backups (repo_name, branch, file_name, status, error_msg, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(repoName, branch, fileName, status, errorMsg, (/* @__PURE__ */ new Date()).toISOString()).run();
      } else {
        console.warn("D1 DB binding is missing, skipping log entry.");
      }
    } catch (dbError) {
      console.error("Failed to log to D1:", dbError);
    }
  }
}
__name(performBackup, "performBackup");
async function handleAdminUI(request, env) {
  const url = new URL(request.url);
  const password = url.searchParams.get("password");
  if (!password || password !== env.ADMIN_PASSWORD) {
    return new Response(`
      <html>
        <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f2f5;">
          <div style="background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2>GitHub Backup Admin</h2>
            <form method="get" action="/">
              <input type="password" name="password" placeholder="Enter Admin Password" style="padding: 8px; margin-right: 8px; border: 1px solid #ccc; border-radius: 4px;" required>
              <button type="submit" style="padding: 8px 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">Login</button>
            </form>
            ${password ? '<p style="color:red;">Invalid Password</p>' : ""}
          </div>
        </body>
      </html>
    `, {
      headers: { "Content-Type": "text/html" },
      status: 200
    });
  }
  return new Response(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Backup Logs</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 20px; background: #f6f8fa; }
        .container { max-width: 900px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        h1 { color: #24292e; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e1e4e8; }
        th { background-color: #f6f8fa; font-weight: 600; }
        .status-success { color: #28a745; font-weight: bold; }
        .status-failed { color: #d73a49; font-weight: bold; }
        .refresh-btn { background: #007bff; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; float: right; }
        .refresh-btn:hover { background: #0056b3; }
      </style>
    </head>
    <body>
      <div class="container">
        <button class="refresh-btn" onclick="loadLogs()">Refresh Logs</button>
        <h1>Recent Backups</h1>
        <table id="logTable">
          <thead>
            <tr>
              <th>Time</th>
              <th>Repository</th>
              <th>Branch</th>
              <th>File Name</th>
              <th>Status</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="6">Loading...</td></tr>
          </tbody>
        </table>
      </div>
      <script>
        async function loadLogs() {
          try {
            const res = await fetch('/api/logs?password=${env.ADMIN_PASSWORD}');
            const data = await res.json();
            const tbody = document.querySelector('#logTable tbody');
            tbody.innerHTML = '';
            
            if (data.logs.length === 0) {
              tbody.innerHTML = '<tr><td colspan="6">No logs found.</td></tr>';
              return;
            }

            data.logs.forEach(log => {
              const tr = document.createElement('tr');
              const statusClass = log.status === 'success' ? 'status-success' : 'status-failed';
              tr.innerHTML = \`
                <td>\${new Date(log.created_at).toLocaleString()}</td>
                <td>\${log.repo_name}</td>
                <td>\${log.branch}</td>
                <td>\${log.file_name || '-'}</td>
                <td class="\${statusClass}">\${log.status}</td>
                <td style="color: #666; font-size: 0.9em;">\${log.error_msg || ''}</td>
              \`;
              tbody.appendChild(tr);
            });
          } catch (e) {
            console.error(e);
            document.querySelector('#logTable tbody').innerHTML = '<tr><td colspan="6">Failed to load logs.</td></tr>';
          }
        }
        loadLogs();
      <\/script>
    </body>
    </html>
  `, {
    headers: { "Content-Type": "text/html" },
    status: 200
  });
}
__name(handleAdminUI, "handleAdminUI");
async function handleGetLogs(request, env) {
  const url = new URL(request.url);
  const password = url.searchParams.get("password");
  if (password !== env.ADMIN_PASSWORD) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: "D1 DB not configured" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    const { results } = await env.DB.prepare("SELECT * FROM backups ORDER BY created_at DESC LIMIT 50").all();
    return new Response(JSON.stringify({ logs: results }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
__name(handleGetLogs, "handleGetLogs");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map

