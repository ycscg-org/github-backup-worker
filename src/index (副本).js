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
    if (pathname === "/api/settings" && request.method === "GET") {
      return await handleGetSettings(request, env);
    }
    if (pathname === "/api/settings" && request.method === "POST") {
      return await handleSaveSettings(request, env);
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
  if (!isAuthed(request, env)) {
    return Response.json({ status: "error", message: "登录已过期，请重新登录" }, { status: 401 });
  }
  if (!env.KV) {
    return Response.json({ status: "error", message: "KV 未绑定，无法查询全量备份进度。请在本项目 wrangler.toml 中绑定名为 KV 的 KV 命名空间后重新部署" }, { status: 500 });
  }

  const result = await env.KV.get('sync_result');
  if (!result) return Response.json({ status: 'pending' });

  await env.KV.delete('sync_result');
  try {
    return Response.json(JSON.parse(result));
  } catch (e) {
    return Response.json({ status: "error", message: "进度数据解析失败：" + e.message }, { status: 500 });
  }
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
    const kvReady = !!env.KV;
    return Response.json({
      success: true,
      kv: kvReady,
      message: kvReady
        ? `已提交 ${orgName} 的全量备份任务（单次上限 ${limit} 个），请稍后在日志中查看`
        : `已提交 ${orgName} 的全量备份任务，但未绑定 KV，页面无法显示进度，请稍后点击“刷新日志”查看结果`
    });
  } catch (e) {
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

async function performOrgSync(env, orgName, limit) {
  try {
    if (env.KV) {
      await env.KV.put('sync_result', JSON.stringify({ status: 'pending' }), { expirationTtl: 300 });
    }

    // 启动前先检查是否已处于熔断状态，避免空跑
    const prePause = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_paused'").first();
    if (prePause && prePause.value === 'true') {
      if (env.KV) {
        await env.KV.put('sync_result', JSON.stringify({ 
          status: 'error', 
          message: "备份功能已因 R2 存储空间不足被熔断。请先清理旧备份并点击「恢复备份」后再重试。" 
        }), { expirationTtl: 300 });
      }
      return;
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
    
    let successCount = 0;  // 实际成功备份的数量
    let skipped = 0;       // 跳过（已是最新）的数量
    let failed = 0;        // 备份失败的数量

    for (const repo of repos) {
      if (successCount + failed >= limit) {
        console.log(`已达到单次备份上限 ${limit} 个，停止执行`);
        break; 
      }

      // 每个仓库备份前先检查熔断状态，触发后立即终止循环
      const pauseCheck = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_paused'").first();
      if (pauseCheck && pauseCheck.value === 'true') {
        console.log("检测到熔断触发，终止剩余仓库备份");
        if (env.KV) {
          await env.KV.put('sync_result', JSON.stringify({ 
            status: 'error', 
            paused: true,
            success: successCount,
            skipped: skipped,
            failed: failed,
            message: `备份中途因 R2 存储空间不足被熔断。已成功备份 ${successCount} 个，失败 ${failed} 个，跳过 ${skipped} 个。请清理空间后重试。` 
          }), { expirationTtl: 300 });
        }
        return;
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

      console.log(`[${successCount + failed + 1}/${limit}] 触发备份: ${repo.full_name} (${repo.default_branch})`);
      // performBackup 现在返回是否成功
      const backupOk = await performBackup(env, repo.owner.login, repo.name, repo.default_branch || "main", repo.clone_url);
      if (backupOk) {
        successCount++;
      } else {
        failed++;
      }
    }

    console.log(`组织备份任务结束。本次成功备份 ${successCount} 个仓库，失败 ${failed} 个，跳过了 ${skipped} 个已备份仓库。`);

    // 循环结束后再检查一次熔断（最后一个仓库触发熔断的场景）
    const finalPause = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_paused'").first();
    if (finalPause && finalPause.value === 'true') {
      if (env.KV) {
        await env.KV.put('sync_result', JSON.stringify({ 
          status: 'error', 
          paused: true,
          success: successCount,
          skipped: skipped,
          failed: failed,
          message: `备份中途因 R2 存储空间不足被熔断。已成功备份 ${successCount} 个，失败 ${failed} 个，跳过 ${skipped} 个。请清理空间后重试。` 
        }), { expirationTtl: 300 });
      }
      return;
    }

    if (env.KV) {
      await env.KV.put('sync_result', JSON.stringify({ 
        status: 'done', 
        count: successCount, 
        skipped: skipped,
        failed: failed,
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
}

// ---------- 备份执行 ----------
// 返回值：true=备份成功，false=备份失败
async function performBackup(env, owner, repoName, branch, cloneUrl) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${owner}-${repoName}-${branch}-${timestamp}.tar.gz`;
  let status = "failed";
  let errorMsg = "";
  let fileSize = 0;
  try {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
    if (!env.BUCKET) throw new Error("R2 BUCKET binding is missing");
    // 只要当前已用空间 + 预留空间超过上限，就会触发熔断
    await checkAndCleanSpace(env, 1024 * 100);

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

    const lengthHeader = response.headers.get("Content-Length");
    const contentLength = lengthHeader ? Number(lengthHeader) : NaN;

    // 下载前再次检查空间是否足够存下当前文件
    if (Number.isFinite(contentLength) && contentLength > 0) {
      await checkAndCleanSpace(env, contentLength);
    }

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
      // 缓冲模式下上传前再检查一次
      await checkAndCleanSpace(env, fileSize);
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
        if (status === "success") {
          await cleanupOldBackups(env, repoName, branch);
        }
      } else {
        console.warn("D1 DB binding is missing, skipping log entry.");
      }
    } catch (dbError) {
      console.error("Failed to log to D1:", dbError);
    }
  }
  return status === "success";
}

async function checkAndCleanSpace(env, incomingSize = 0) {
  const setting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'r2_max_gb'").first();
  const maxGB = parseFloat(setting ? setting.value : "10");
  const maxBytes = maxGB * 1024 * 1024 * 1024;
  
  const { total } = await env.DB.prepare(
    "SELECT SUM(file_size) as total FROM backups WHERE status = 'success'"
  ).first();
  let currentSize = total || 0;

  // 如果空间够了，直接自动解除之前可能存在的熔断
  if (currentSize + incomingSize <= maxBytes) {
    await env.DB.prepare("UPDATE settings SET value = 'false' WHERE key = 'backup_paused'").run();
    return; // 直接放行
  }

  // 如果空间不够，且已经熔断了，就直接抛出错误拦截
  const pauseState = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_paused'").first();
  if (pauseState && pauseState.value === 'true') {
    throw new Error("可用空间不足，已暂停所有备份功能。请手动清理历史备份并在管理面板点击恢复。");
  }

  console.warn(`[容量预警] 空间不足（已用 ${(currentSize/1024/1024).toFixed(2)}MB / 上限 ${maxGB}GB），开始智能清理冗余备份...`);

  // 智能清理：保留每个库最新的一条，删除其余的
  const { results: redundantBackups } = await env.DB.prepare(`
    WITH RankedBackups AS (
      SELECT id, file_name, file_size,
             ROW_NUMBER() OVER (PARTITION BY repo_name, branch ORDER BY created_at DESC) as rn
      FROM backups
      WHERE status = 'success'
    )
    SELECT id, file_name, file_size FROM RankedBackups 
    WHERE rn > 1 
    ORDER BY id ASC
  `).all();

  for (const backup of redundantBackups) {
    if (currentSize + incomingSize <= maxBytes) break; 
    try {
      await env.BUCKET.delete(backup.file_name);
      await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(backup.id).run();
      currentSize -= backup.file_size;
      console.log(`[容量清理] 已删除冗余历史备份: ${backup.file_name} (释放 ${(backup.file_size/1024/1024).toFixed(2)}MB)`);
    } catch (e) {
      console.error(`[容量清理] 删除失败: ${backup.file_name}`, e);
    }
  }

    // 如果删光了冗余记录，空间还是不够，触发熔断
  if (currentSize + incomingSize > maxBytes) {
    try {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_paused', 'true')"
      ).run();
    } catch (e) {
      console.error("写入熔断状态失败:", e);
    }
    throw new Error("所有仓库均已只剩最新备份，空间依然不足。系统已自动暂停备份，请在管理面板清理并解除暂停。");
  }
}

// ---------- 管理 UI ----------
async function handleAdminUI(request, env) {
  if (!isAuthed(request, env)) {
    return new Response(loginPageHtml(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"  // 禁止缓存管理页，避免部署后用户拿到旧脚本
      },
      status: 200
    });
  }
  return new Response(adminPageHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    },
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
  <!-- 熔断警告横幅（默认隐藏） -->
    <div id="pauseWarning" style="margin-bottom: 20px; padding: 15px; background: #ffebe9; border: 1px solid #ff8182; border-radius: 6px; color: #d73a49; display: none; justify-content: space-between; align-items: center;">
    <strong>⚠️ R2空间不足，备份无法保存，已暂停所有自动及手动备份功能。请点击下方表格中的“删除”清理一些旧备份，腾出空间后点击右侧按钮恢复。</strong>
    <button onclick="resumeBackups()" style="padding: 6px 16px; background: #d73a49; color: #fff; border: none; border-radius: 4px; cursor: pointer;">恢复备份</button>
  </div>

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
  <!-- 系统设置区块 -->
  <div style="margin-top: 16px; padding: 12px; background: #eef2f5; border: 1px solid #cbd5e1; border-radius: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
    <strong>系统设置：</strong>
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;">
      R2 最大可用空间：
      <input id="r2MaxGb" type="number" step="0.5" value="10" min="1" max="1000" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 80px;" />
      GB
    </label>
    <button onclick="saveSettings()" style="padding: 6px 16px; background: #475569; color: #fff; border: none; border-radius: 4px; cursor: pointer;">保存设置</button>
    <span style="font-size: 12px; color: #666; width: 100%;">提示：如果多个 Worker 共用 R2，请扣除其他项目占用的空间。例如 R2 总额度 10GB，其他占用 3GB，此处填 7。</span>
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
    // 拉取系统设置状态，失败不阻塞日志加载
    let isPaused = false;
    try {
      const setRes = await fetch('/api/settings', { cache: 'no-store' });
      if (setRes.ok) {
        const setData = await setRes.json();
        isPaused = setData.success && setData.settings && setData.settings.backup_paused === 'true';
      }
    } catch (e) {
      console.warn("加载设置状态失败", e);
    }
    document.getElementById('pauseWarning').style.display = isPaused ? 'flex' : 'none';

    // 原有的日志加载逻辑
    const res = await fetch('/api/logs', { cache: 'no-store' });
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

async function loadSettings() {
  try {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    if (res.status === 401) return;
    const data = await res.json();
    if (data.success && data.settings.r2_max_gb) {
      document.getElementById('r2MaxGb').value = data.settings.r2_max_gb;
    }
  } catch(e) { console.error("加载设置失败", e); }
}

async function saveSettings() {
  const val = document.getElementById('r2MaxGb').value;
  if (!val || parseFloat(val) < 1) return alert('请输入有效的数值');
  
  const btn = document.querySelector('button[onclick="saveSettings()"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '保存中...';
  
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ r2_max_gb: parseFloat(val) })
    });
    const result = await res.json();
    if (result.success) {
      alert('设置已更新');
      loadLogs(); // 保存后刷新横幅状态
    } else {
      alert('保存失败：' + result.message);
    }
  } catch(e) {
    alert('请求失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function resumeBackups() {
  if (!confirm("确认要恢复备份功能吗？请确保您已经调大了最大可用空间或清理了历史记录。")) return;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup_paused: 'false' })
    });
    const result = await res.json();
    if (result.success) {
      alert('已解除熔断，请刷新页面。');
      location.reload();
    } else {
      alert('恢复失败：' + result.message);
    }
  } catch (e) {
    alert('请求失败：' + e.message);
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

function finishPolling(btn, originalText) {
  isPolling = false;
  btn.disabled = false;
  btn.textContent = originalText;
}

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

  // 先把上一次残留的轮询状态复位，避免本次点击被静默吞掉
  isPolling = false;
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
    
    if (!result.success) {
      finishPolling(btn, originalText);
      alert('提交失败：' + (result.message || '未知错误'));
      return;
    }

    if (result.kv === false) {
      finishPolling(btn, originalText);
      alert(result.message || '任务已提交，但后台未绑定 KV，页面无法显示进度，请稍后点击“刷新日志”查看结果。');
      return;
    }

    isPolling = true;
    pollSyncStatus(btn, originalText);
  } catch (e) {
    finishPolling(btn, originalText);
    alert('请求失败：' + e.message);
  }
}

async function pollSyncStatus(btn, originalText) {
  const MAX_ATTEMPTS = 60; // 60 次 × 3 秒 = 3 分钟，适配最多 100 个仓库的场景

  const retry = () => {
    const attempts = parseInt(btn.getAttribute('data-poll-attempts') || '0', 10) + 1;
    btn.setAttribute('data-poll-attempts', String(attempts));
    if (attempts >= MAX_ATTEMPTS) {
      finishPolling(btn, originalText);
      alert('进度查询超时（约 3 分钟未拿到结果）。后台任务可能仍在执行，或被 Worker 执行时限中断。请稍后点击“刷新日志”查看；若一直如此，请确认已绑定名为 KV 的 KV 命名空间。');
      loadLogs();
      return;
    }
    setTimeout(() => pollSyncStatus(btn, originalText), 3000);
  };

  try {
    const res = await fetch('/api/backup/sync-status', { cache: 'no-store' });

    if (res.status === 401) {
      finishPolling(btn, originalText);
      alert('登录已过期，请重新登录后再试。');
      return;
    }

    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json()).message || ''; } catch (err) { reason = ''; }
      if (reason) {
        finishPolling(btn, originalText);
        alert('查询备份进度失败：' + reason);
        loadLogs(); // 出错也刷新日志，让横幅显示出来
        return;
      }
      retry();
      return;
    }

    const data = await res.json();

    if (data.status === 'done') {
      finishPolling(btn, originalText);
      const failedTip = data.failed > 0 ? ('，失败 ' + data.failed + ' 个') : '';
      alert('备份完成！本次成功备份：' + data.count + ' 个仓库，跳过已备份：' + data.skipped + ' 个仓库' + failedTip);
      loadLogs();
      return;
    }

    if (data.status === 'error') {
      finishPolling(btn, originalText);
      alert(data.message || '备份任务失败：未知错误');
      loadLogs(); // 关键：错误时刷新日志，熔断横幅会立即显示
      return;
    }

    // pending 或任何未知状态：一律继续等待，并计入同一个超时计数
    retry();
  } catch (e) {
    console.error('轮询状态失败', e);
    retry();
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
loadSettings();
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
// 获取设置
async function handleGetSettings(request, env) {
  if (!isAuthed(request, env)) return Response.json({ success: false, message: "未授权访问" }, { status: 401 });
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
    const settings = {};
    for (const row of results) {
      settings[row.key] = row.value;
    }
    return Response.json({ success: true, settings });
  } catch (e) {
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

// 保存设置
async function handleSaveSettings(request, env) {
  if (!isAuthed(request, env)) return Response.json({ success: false, message: "未授权访问" }, { status: 401 });
  try {
    const body = await parseJson(request);
    
    if (body.r2_max_gb !== undefined) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('r2_max_gb', ?)"
      ).bind(body.r2_max_gb.toString()).run();
    }
    
    if (body.backup_paused !== undefined) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_paused', ?)"
      ).bind(body.backup_paused).run();
    }
    
    return Response.json({ success: true, message: "设置已保存" });
  } catch (e) {
    return Response.json({ success: false, message: e.message }, { status: 500 });
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
    await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(row.id).run();
    
    // 删除后检查空间是否足够，足够则自动解除熔断
    const setting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'r2_max_gb'").first();
    const maxGB = parseFloat(setting ? setting.value : "10");
    const maxBytes = maxGB * 1024 * 1024 * 1024;
    const { total } = await env.DB.prepare(
      "SELECT SUM(file_size) as total FROM backups WHERE status = 'success'"
    ).first();
    if ((total || 0) <= maxBytes) {
      await env.DB.prepare("UPDATE settings SET value = 'false' WHERE key = 'backup_paused'").run();
    }
    
    return Response.json({ success: true, message: "删除成功" });
  } catch (e) {
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

// ---------- 旧备份清理 ----------
async function cleanupOldBackups(env, repoName, branch) {
  const retainCount = parseInt(env.BACKUP_RETAIN_COUNT || "5", 10);
  const failedRetainCount = parseInt(env.BACKUP_FAILED_RETAIN_COUNT || "5", 10);
  
  // 清理成功的旧备份
  const { results: successBackups } = await env.DB.prepare(
    "SELECT id, file_name FROM backups WHERE repo_name = ? AND branch = ? AND status = 'success' ORDER BY created_at DESC"
  ).bind(repoName, branch).all();
  
  if (successBackups.length > retainCount) {
    const toDelete = successBackups.slice(retainCount);
    for (const b of toDelete) {
      try {
        await env.BUCKET.delete(b.file_name);
        await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(b.id).run();
        console.log(`[清理旧备份] 删除成功备份: ${b.file_name}`);
      } catch (e) {
        console.error(`清理旧备份失败: ${b.file_name}`, e);
      }
    }
  }
  
  // 清理失败的旧记录（没有对应的R2文件）
  const { results: failedBackups } = await env.DB.prepare(
    "SELECT id FROM backups WHERE repo_name = ? AND branch = ? AND status = 'failed' ORDER BY created_at DESC"
  ).bind(repoName, branch).all();
  
  if (failedBackups.length > failedRetainCount) {
    const toDelete = failedBackups.slice(failedRetainCount);
    for (const b of toDelete) {
      await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(b.id).run();
    }
  }
}

export { index_default as default };
