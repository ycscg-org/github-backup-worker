var BACKUP_RETAIN_COUNT = 5;

// ---------- 工具 ----------
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

function getSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function isAuthed(request, env) {
  const token = getSessionToken(request);
  if (!token) return false;
  return timingSafeEqual(token, env.ADMIN_PASSWORD);
}

function sessionCookie(value, maxAge = 86400) {
  return `session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function isValidBackupFileName(name) {
  if (typeof name !== "string" || name.length > 255) return false;
  if (name.includes("..")) return false;
  return /^[A-Za-z0-9._-]+\.tar\.gz$/.test(name);
}

async function parseJson(request) {
  try { return await request.json(); } catch { return null; }
}

// ---------- 入口 ----------
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/webhook" && request.method === "POST") {
      return await handleWebhook(request, env, ctx);
    }
    if (pathname === "/login" && request.method === "POST") {
      return await handleLogin(request, env);
    }
    if (pathname === "/logout" && request.method === "POST") {
      return new Response(null, {
        status: 204,
        headers: { "Set-Cookie": "session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" }
      });
    }
    if (pathname === "/" || pathname === "/admin") {
      return await handleAdminUI(request, env);
    }
    if (pathname === "/api/logs" && request.method === "GET") {
      return await handleGetLogs(request, env);
    }
    if (pathname === "/api/backup/download" && request.method === "GET") {
      return await handleDownloadBackup(request, env);
    }
    if (pathname === "/api/backup/delete" && request.method === "DELETE") {
      return await handleDeleteBackup(request, env);
    }
    if (pathname === "/api/backup/trigger" && request.method === "POST") {
      return await handleTriggerBackup(request, env, ctx);
    }
    if (pathname === "/api/backup/sync-org" && request.method === "POST") {
      return await handleSyncOrg(request, env, ctx);
    }
    if (pathname === "/api/backup/sync-status" && request.method === "GET") {
      return await handleSyncStatus(request, env);
    }
    return new Response("Not Found", { status: 404 });
  }
};

// ---------- 登录 ----------
async function handleLogin(request, env) {
  const body = await parseJson(request);
  if (!body || typeof body.password !== "string") {
    return new Response(JSON.stringify({ success: false, message: "缺少密码" }),
      { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!env.ADMIN_PASSWORD || !timingSafeEqual(body.password, env.ADMIN_PASSWORD)) {
    return new Response(JSON.stringify({ success: false, message: "密码错误" }),
      { status: 401, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookie(env.ADMIN_PASSWORD)
    }
  });
}

// ---------- Webhook ----------
async function handleWebhook(request, env, ctx) {
  const event = request.headers.get("X-GitHub-Event");
  if (event && event !== "push") {
    return new Response("Ignored event", { status: 200 });
  }

  const raw = await request.text();
  const sigHeader = request.headers.get("X-Hub-Signature-256") || "";
  if (!env.WEBHOOK_SECRET || !sigHeader.startsWith("sha256=")) {
    return new Response("Missing signature", { status: 401 });
  }
  const expected = await hmacSha256Hex(env.WEBHOOK_SECRET, raw);
  if (!timingSafeEqual(sigHeader.slice(7), expected)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let body;
  try { body = JSON.parse(raw); } catch { return new Response("Invalid JSON", { status: 400 }); }

  if (body.deleted) return new Response("Ignored: branch deleted", { status: 200 });
  if (!body.ref || !body.ref.startsWith("refs/heads/")) {
    return new Response("Ignored: non-branch ref", { status: 200 });
  }
  if (!body.repository || !body.repository.name || !body.repository.owner) {
    return new Response("Missing repo info", { status: 400 });
  }

  const branch = body.ref.slice("refs/heads/".length);
  const repoName = body.repository.name;
  const owner = body.repository.owner.login;
  const cloneUrl = body.repository.clone_url;

  console.log(`Triggering backup for ${owner}/${repoName}@${branch}`);
  ctx.waitUntil(performBackup(env, owner, repoName, branch, cloneUrl));
  return new Response("Backup triggered", { status: 200 });
}

async function hmacSha256Hex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- 手动备份 ----------
async function handleTriggerBackup(request, env, ctx) {
  if (!isAuthed(request, env)) {
    return Response.json({ success: false, message: "未授权访问" }, { status: 401 });
  }
  try {
    const body = await parseJson(request);
    const repoFullName = body.repo;
    const branch = body.branch || "main";

    if (!repoFullName || !repoFullName.includes("/")) {
      return Response.json({ success: false, message: "仓库格式错误，请填写 owner/repo" }, { status: 400 });
    }

    const [owner, repoName] = repoFullName.split("/");
    ctx.waitUntil(performBackup(env, owner, repoName, branch, ""));
    return Response.json({ success: true, message: "备份任务已提交后台执行" });
  } catch (e) {
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

// ---------- 组织全量备份 ----------
async function handleSyncStatus(request, env) {
  if (!isAuthed(request, env)) return Response.json({ success: false, message: "未授权访问" }, { status: 401 });
  if (!env.KV) return Response.json({ success: false, message: "KV 未绑定" }, { status: 500 });
  
  const result = await env.KV.get('sync_result');
  if (!result) return Response.json({ status: 'pending' });
  
  await env.KV.delete('sync_result');
  return Response.json(JSON.parse(result));
}

async function handleSyncOrg(request, env, ctx) {
  if (!isAuthed(request, env)) {
    return Response.json({ success: false, message: "未授权访问" }, { status: 401 });
  }
  try {
    const body = await parseJson(request);
    const orgName = body.org;
    const limit = parseInt(body.limit, 10) || 10; 

    if (!orgName) {
      return Response.json({ success: false, message: "请填写组织名称" }, { status: 400 });
    }

    const checkRes = await fetch(`https://api.github.com/orgs/${orgName}/repos?per_page=1`, {
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "github-backup-worker-cloudflare"
      }
    });

    if (checkRes.status === 404) {
      return Response.json({ success: false, message: `组织 "${orgName}" 不存在，请检查拼写` }, { status: 404 });
    }
    if (!checkRes.ok && checkRes.status !== 403) {
       return Response.json({ success: false, message: `GitHub API 错误: ${checkRes.status}` }, { status: 500 });
    }

    if (env.KV) await env.KV.delete('sync_result');
    ctx.waitUntil(performOrgSync(env, orgName, limit));
    return Response.json({ success: true, message: `已提交 ${orgName} 的全量备份任务（单次上限 ${limit} 个），请稍后在日志中查看` });
  } catch (e) {
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

async function performOrgSync(env, orgName, limit) {
  try {
    if (env.KV) {
      await env.KV.put('sync_result', JSON.stringify({ status: 'pending' }), { expirationTtl: 300 });
    }

    const res = await fetch(`https://api.github.com/orgs/${orgName}/repos?per_page=100&sort=updated`, {
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "github-backup-worker-cloudflare"
      }
    });

    if (!res.ok) throw new Error(`获取组织仓库列表失败: ${res.status} ${res.statusText}`);
    const repos = await res.json();
    
    let count = 0;
    let skipped = 0;

    for (const repo of repos) {
      if (count >= limit) {
        console.log(`已达到单次备份上限 ${limit} 个，停止执行`);
        break; 
      }

      const existing = await env.DB.prepare(
        "SELECT created_at FROM backups WHERE repo_name = ? AND status = 'success' ORDER BY created_at DESC LIMIT 1"
      ).bind(repo.name).first();

      let needsBackup = false;
      if (!existing) {
        needsBackup = true;
      } else {
        const lastBackupTime = new Date(existing.created_at).getTime();
        const repoPushedAt = new Date(repo.pushed_at).getTime();
        if (lastBackupTime < repoPushedAt) {
          needsBackup = true; 
        }
      }

      if (!needsBackup) {
        skipped++;
        continue; 
      }

      console.log(`[${count + 1}/${limit}] 触发备份: ${repo.full_name} (${repo.default_branch})`);
      await performBackup(env, repo.owner.login, repo.name, repo.default_branch || "main", repo.clone_url);
      count++;
    }
    console.log(`组织备份任务结束。本次新备份 ${count} 个仓库，跳过了 ${skipped} 个已备份仓库。`);
    
    if (env.KV) {
      await env.KV.put('sync_result', JSON.stringify({ 
        status: 'done', 
        count: count, 
        skipped: skipped, 
        org: orgName 
      }), { expirationTtl: 300 });
    }
  } catch (e) {
    console.error("全量备份组织失败:", e);
    if (env.KV) {
      await env.KV.put('sync_result', JSON.stringify({ 
        status: 'error', 
        message: e.message 
      }), { expirationTtl: 300 });
    }
  }
} // 👈 这是之前缺失的关键大括号

// ---------- 备份执行 ----------
async function performBackup(env, owner, repoName, branch, cloneUrl) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${owner}-${repoName}-${branch}-${timestamp}.tar.gz`;
  let status = "failed";
  let errorMsg = "";
  let fileSize = 0;
  try {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
    if (!env.BUCKET) throw new Error("R2 BUCKET binding is missing");

    const tarballUrl = `https://api.github.com/repos/${owner}/${repoName}/tarball/refs/heads/${branch}`;
    const response = await fetch(tarballUrl, {
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "github-backup-worker-cloudflare"
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub API Error: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error("GitHub API returned no body");
    }

    const lengthHeader = response.headers.get("Content-Length");
    const contentLength = lengthHeader ? Number(lengthHeader) : NaN;

    if (Number.isFinite(contentLength) && contentLength > 0) {
      const { readable, writable } = new FixedLengthStream(contentLength);
      const piping = response.body.pipeTo(writable);
      await env.BUCKET.put(fileName, readable, {
        httpMetadata: { contentType: "application/gzip" }
      });
      await piping;
      fileSize = contentLength;
    } else {
      console.warn("No Content-Length from GitHub, falling back to buffered upload");
      const buf = await response.arrayBuffer();
      fileSize = buf.byteLength;
      await env.BUCKET.put(fileName, new Uint8Array(buf), {
        httpMetadata: { contentType: "application/gzip" }
      });
    }

    status = "success";
    console.log(`Backup successful: ${fileName}, size: ${fileSize} bytes`);
  } catch (e) {
    status = "failed";
    errorMsg = e.message;
    console.error(`Backup failed for ${repoName}: ${errorMsg}`, e.stack || "");
  } finally {
    try {
      if (env.DB) {
        await env.DB.prepare(
          "INSERT INTO backups (repo_name, branch, file_name, file_size, status, error_msg, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(repoName, branch, fileName, fileSize, status, errorMsg, new Date().toISOString()).run();
        await cleanupOldBackups(env, repoName, branch);
      } else {
        console.warn("D1 DB binding is missing, skipping log entry.");
      }
    } catch (dbError) {
      console.error("Failed to log to D1:", dbError);
    }
  }
}

async function cleanupOldBackups(env, repoName, branch) {
  const successRetain = parseInt(env.BACKUP_RETAIN_COUNT, 10);
  const failedRetain = parseInt(env.BACKUP_FAILED_RETAIN_COUNT, 10);
  const keepSuccess = Number.isFinite(successRetain) && successRetain >= 1 ? successRetain : 5;
  const keepFailed = Number.isFinite(failedRetain) && failedRetain >= 0 ? failedRetain : 20;

  try {
    const { results: oldSuccess } = await env.DB.prepare(
      "SELECT id, file_name FROM backups WHERE repo_name = ? AND branch = ? AND status = 'success' ORDER BY created_at DESC LIMIT -1 OFFSET ?"
    ).bind(repoName, branch, keepSuccess).all();

    for (const old of oldSuccess) {
      let r2Deleted = false;
      try {
        await env.BUCKET.delete(old.file_name);
        r2Deleted = true;
      } catch (e) {
        console.error(`清理 R2 失败，保留 DB 记录待重试: ${old.file_name}`, e);
      }
      if (r2Deleted) {
        try {
          await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(old.id).run();
        } catch (e) {
          console.error(`清理 DB 失败，下次重试: id=${old.id}`, e);
        }
      }
    }
  } catch (e) {
    console.error("清理成功备份失败:", e);
  }

  try {
    const { results: oldFailed } = await env.DB.prepare(
      "SELECT id FROM backups WHERE repo_name = ? AND branch = ? AND status = 'failed' ORDER BY created_at DESC LIMIT -1 OFFSET ?"
    ).bind(repoName, branch, keepFailed).all();

    for (const old of oldFailed) {
      try {
        await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(old.id).run();
      } catch (e) {
        console.error(`清理失败记录 DB 失败: id=${old.id}`, e);
      }
    }
  } catch (e) {
    console.error("清理失败备份失败:", e);
  }
}

// ---------- 管理 UI ----------
async function handleAdminUI(request, env) {
  if (!isAuthed(request, env)) {
    return new Response(loginPageHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200
    });
  }
  return new Response(adminPageHtml(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: 200
  });
}

function loginPageHtml() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>GitHub Backup Admin</title></head>
<body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f2f5;">
  <div style="background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);">
    <h2>GitHub Backup Admin</h2>
    <input id="pw" type="password" placeholder="Admin Password" style="padding:8px;margin-right:8px;border:1px solid #ccc;border-radius:4px;" />
    <button onclick="login()" style="padding:8px 16px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;">Login</button>
    <p id="msg" style="color:red;min-height:1em;"></p>
  </div>
  <script>
    async function login() {
      const pw = document.getElementById('pw').value;
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      if (res.ok) { location.reload(); }
      else { document.getElementById('msg').textContent = '密码错误'; }
    }
    document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  </script>
</body></html>`;
}

function adminPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>备份日志管理</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:20px;background:#f6f8fa;}
  .container{max-width:1100px;margin:0 auto;background:#fff;padding:20px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);}
  h1{color:#24292e;}
  table{width:100%;border-collapse:collapse;margin-top:20px;table-layout:fixed;}
  th,td{padding:12px;text-align:left;border-bottom:1px solid #e1e4e8;word-break:break-all;}
  th{background:#f6f8fa;font-weight:600;}
  .status-success{color:#28a745;font-weight:bold;}
  .status-failed{color:#d73a49;font-weight:bold;}
  .refresh-btn{background:#007bff;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;float:right;}
  .btn{padding:4px 10px;border:none;border-radius:4px;cursor:pointer;font-size:14px;color:#fff;text-decoration:none;display:inline-block;margin-right:6px;}
  .btn-download{background:#28a745;}
  .btn-delete{background:#d73a49;}
  .btn:disabled{opacity:.6;cursor:not-allowed;}
  .col-time{width:160px;}.col-repo{width:150px;}.col-branch{width:100px;}.col-size{width:90px;}.col-status{width:70px;}.col-action{width:130px;}
</style></head>
<body>
<div class="container">
  <button class="refresh-btn" onclick="loadLogs()">刷新日志</button>
  <button class="refresh-btn" style="background:#6c757d;margin-right:8px;" onclick="logout()">退出</button>
  <div style="margin-top: 20px; display: flex; align-items: center; gap: 10px;">
  <label for="repoFilter" style="font-weight: 600; color: #24292e;">筛选仓库：</label>
  <select id="repoFilter" onchange="renderTable()" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
  <option value="">全部仓库</option>
  </select>
  </div>
  <div style="margin-top: 16px; padding: 12px; background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
    <strong>手动备份单库：</strong>
    <input id="manualRepo" type="text" placeholder="owner/repo (如 ycscg-org/github-backup-worker)" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 300px;" />
    <input id="manualBranch" type="text" placeholder="分支 (默认 main)" value="main" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 120px;" />
    <button onclick="triggerManualBackup()" style="padding: 6px 16px; background: #007bff; color: #fff; border: none; border-radius: 4px; cursor: pointer;">开始备份</button>
  </div>
  <div style="margin-top: 16px; padding: 12px; background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
    <strong>全量备份组织：</strong>
    <input id="syncOrgName" type="text" placeholder="组织名 (如 ycscg-org)" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 180px;" />
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;">
      单次最多备份：
      <input id="syncLimit" type="number" value="10" min="1" max="100" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 60px;" />
      个
    </label>
    <button onclick="syncOrganization()" style="padding: 6px 16px; background: #d73a49; color: #fff; border: none; border-radius: 4px; cursor: pointer;">开始全量备份</button>
    <span style="font-size: 12px; color: #666; width: 100%;">提示：程序会自动跳过已成功备份最新代码的仓库。如果遇到超大仓库导致超时，可把数量改为 1 并单独尝试。</span>
  </div>
  <h1>GitHub 备份管理</h1>
  <table id="logTable">
    <thead><tr>
      <th class="col-time">时间</th><th class="col-repo">仓库</th><th class="col-branch">分支</th>
      <th>文件名</th><th class="col-size">大小</th><th class="col-status">状态</th>
      <th>错误信息</th><th class="col-action">操作</th>
    </tr></thead>
    <tbody><tr><td colspan="8">加载中...</td></tr></tbody>
  </table>
</div>
<script>
function formatSize(bytes){ if(!bytes||bytes===0) return '未知'; const u=['B','KB','MB','GB']; const i=Math.floor(Math.log(bytes)/Math.log(1024)); return (bytes/Math.pow(1024,i)).toFixed(2)+' '+u[i]; }
async function logout(){ await fetch('/logout',{method:'POST'}); location.reload(); }
async function deleteBackup(fileName, btn){
  if(!confirm('确定要删除记录「'+fileName+'」吗？此操作不可恢复！')) return;
  btn.disabled = true; btn.textContent = '删除中...';
  try {
    const res = await fetch('/api/backup/delete?file=' + encodeURIComponent(fileName), { method:'DELETE' });
    const result = await res.json();
    if (result.success) { alert('删除成功'); loadLogs(); }
    else { alert('删除失败：' + (result.message || '未知错误')); btn.disabled = false; btn.textContent = '删除'; }
  } catch(e) { alert('删除失败：' + e.message); btn.disabled = false; btn.textContent = '删除'; }
}
let allLogs = []; 

async function loadLogs(){
  try {
    const res = await fetch('/api/logs');
    if (res.status === 401) { location.reload(); return; }
    const data = await res.json();
    allLogs = data.logs || [];

    const select = document.getElementById('repoFilter');
    const currentVal = select.value;
    const repos = [...new Set(allLogs.map(l => l.repo_name))].sort();

    select.innerHTML = '<option value="">全部仓库</option>';
    repos.forEach(repo => {
      const opt = document.createElement('option');
      opt.value = repo;
      opt.textContent = repo;
      select.appendChild(opt);
    });
    if (repos.includes(currentVal)) select.value = currentVal;

    renderTable();
  } catch(e) {
    console.error(e);
    document.querySelector('#logTable tbody').innerHTML = '<tr><td colspan="8">加载日志失败</td></tr>';
  }
}

async function triggerManualBackup() {
  const repo = document.getElementById('manualRepo').value.trim();
  const branch = document.getElementById('manualBranch').value.trim() || 'main';
  
  if (!repo || !repo.includes('/')) {
    alert('请输入正确的仓库格式，例如：ycscg-org/github-backup-worker');
    return;
  }

  const btn = document.querySelector('button[onclick="triggerManualBackup()"]');
  btn.disabled = true;
  btn.textContent = '提交中...';

  try {
    const res = await fetch('/api/backup/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, branch })
    });
    const result = await res.json();
    if (result.success) {
      alert('任务已提交，稍等几秒后点击“刷新日志”查看结果');
      document.getElementById('manualRepo').value = '';
    } else {
      alert('提交失败：' + result.message);
    }
  } catch (e) {
    alert('请求失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始备份';
  }
}

let isPolling = false; 

async function syncOrganization() {
  const org = document.getElementById('syncOrgName').value.trim();
  const limit = document.getElementById('syncLimit').value || 10;
  
  if (!org) {
    alert('请输入 GitHub 组织名称');
    return;
  }

  if (!confirm('确定要触发组织 "' + org + '" 的全量备份吗？将自动补齐未备份的仓库（本次最多处理 ' + limit + ' 个）。')) {
    return;
  }

  const btn = document.querySelector('button[onclick="syncOrganization()"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '后台执行中 (请稍候)...';
  btn.setAttribute('data-poll-attempts', '0');

  try {
    const res = await fetch('/api/backup/sync-org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org, limit: parseInt(limit, 10) })
    });
    const result = await res.json();
    
    if (result.success) {
      if (!isPolling) {
        isPolling = true;
        pollSyncStatus(btn, originalText);
      }
    } else {
      alert('提交失败：' + result.message);
      btn.disabled = false;
      btn.textContent = originalText;
    }
  } catch (e) {
    alert('请求失败：' + e.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function pollSyncStatus(btn, originalText) {
  try {
    const res = await fetch('/api/backup/sync-status');
    const data = await res.json();

    if (data.status === 'pending') {
      const attempts = parseInt(btn.getAttribute('data-poll-attempts') || '0', 10);
      if (attempts >= 30) {
        isPolling = false;
        btn.disabled = false;
        btn.textContent = originalText;
        alert('后台任务超时，可能因仓库过大导致 Worker 执行超时被中断。请稍后刷新日志查看。');
        return;
      }
      btn.setAttribute('data-poll-attempts', attempts + 1);
      setTimeout(() => pollSyncStatus(btn, originalText), 3000);
    } else if (data.status === 'done') {
      isPolling = false;
      btn.disabled = false;
      btn.textContent = originalText;
      alert('备份完成！本次新备份：' + data.count + ' 个仓库，跳过已备份：' + data.skipped + ' 个仓库');
      loadLogs();
    } else if (data.status === 'error') {
      isPolling = false;
      btn.disabled = false;
      btn.textContent = originalText;
      alert('备份任务失败：' + data.message);
    }
  } catch (e) {
    console.error("轮询状态失败", e);
    setTimeout(() => pollSyncStatus(btn, originalText), 3000);
  }
}

function renderTable(){
  const tbody = document.querySelector('#logTable tbody');
  tbody.innerHTML = '';

  const selectedRepo = document.getElementById('repoFilter').value;
  const filteredLogs = selectedRepo
  ? allLogs.filter(l => l.repo_name === selectedRepo)
  : allLogs;

  if (filteredLogs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8">暂无备份记录</td></tr>';
    return;
  }

  filteredLogs.forEach(log => {
    const tr = document.createElement('tr');
    const canOperate = log.status === 'success' && log.file_name;
    const cells = [
      new Date(log.created_at).toLocaleString('zh-CN'),
      log.repo_name, log.branch,
      log.file_name || '-',
      formatSize(log.file_size),
      log.status === 'success' ? '成功' : '失败',
      log.error_msg || ''
    ];
    cells.forEach((v,i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (i === 5) td.className = log.status === 'success' ? 'status-success' : 'status-failed';
      tr.appendChild(td);
    });
    const tdAction = document.createElement('td');
    if (log.file_name) {
      if (log.status === 'success') {
        const a = document.createElement('a');
        a.href = '/api/backup/download?file=' + encodeURIComponent(log.file_name);
        a.className = 'btn btn-download'; a.textContent = '下载';
        tdAction.appendChild(a);
      }
      const b = document.createElement('button');
      b.className = 'btn btn-delete'; b.textContent = '删除';
      b.onclick = () => deleteBackup(log.file_name, b);
      tdAction.appendChild(b);
    } else {
      tdAction.textContent = '-';
    }
    tr.appendChild(tdAction);
    tbody.appendChild(tr);
  });
}
loadLogs();
<\/script>
</body></html>`;
}

// ---------- API：日志 ----------
async function handleGetLogs(request, env) {
  if (!isAuthed(request, env)) return new Response("Unauthorized", { status: 401 });
  try {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: "D1 DB not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }
    const { results } = await env.DB.prepare(
      "SELECT * FROM backups ORDER BY created_at DESC LIMIT 50"
    ).all();
    return new Response(JSON.stringify({ logs: results }),
      { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// ---------- API：下载 ----------
async function handleDownloadBackup(request, env) {
  if (!isAuthed(request, env)) return new Response("未授权访问", { status: 401 });
  const url = new URL(request.url);
  const fileName = url.searchParams.get("file");
  if (!fileName) return new Response("缺少文件参数", { status: 400 });
  if (!isValidBackupFileName(fileName)) return new Response("非法文件名", { status: 400 });

  if (!env.DB) return new Response("D1 DB not configured", { status: 500 });
  const row = await env.DB.prepare(
    "SELECT file_name FROM backups WHERE file_name = ? AND status = 'success' LIMIT 1"
  ).bind(fileName).first();
  if (!row) return new Response("备份记录不存在", { status: 404 });

  try {
    const backupFile = await env.BUCKET.get(fileName);
    if (!backupFile) return new Response("备份文件不存在，可能已被删除", { status: 404 });

    const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, "_");
    const disposition = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

    const headers = new Headers();
    headers.set("Content-Disposition", disposition);
    headers.set("Content-Type", backupFile.httpMetadata?.contentType || "application/gzip");
    headers.set("Content-Length", String(backupFile.size));
    return new Response(backupFile.body, { headers });
  } catch (e) {
    console.error("Download backup error:", e);
    return new Response(`下载失败: ${e.message}`, { status: 500 });
  }
}

// ---------- API：删除 ----------
async function handleDeleteBackup(request, env) {
  if (!isAuthed(request, env)) {
    return Response.json({ success: false, message: "未授权访问" }, { status: 401 });
  }
  const url = new URL(request.url);
  const fileName = url.searchParams.get("file");
  if (!fileName) return Response.json({ success: false, message: "缺少文件参数" }, { status: 400 });
  if (!isValidBackupFileName(fileName)) return Response.json({ success: false, message: "非法文件名" }, { status: 400 });
  if (!env.DB) return Response.json({ success: false, message: "D1 DB not configured" }, { status: 500 });

  const row = await env.DB.prepare(
    "SELECT id, status FROM backups WHERE file_name = ? LIMIT 1"
  ).bind(fileName).first();
  if (!row) return Response.json({ success: false, message: "记录不存在" }, { status: 404 });

  try {
    if (row.status === 'success') {
      await env.BUCKET.delete(fileName);
    }
    await env.DB.prepare("DELETE FROM backups WHERE file_name = ?").bind(fileName).run();
    return Response.json({ success: true, message: "删除成功" });
  } catch (e) {
    console.error("Delete backup error:", e);
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

export { index_default as default };
