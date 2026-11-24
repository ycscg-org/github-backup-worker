// GitHub Backup Worker v2.18 i18n版 - 独立字典文件 + 相对导入 + 后端错误码 + 所有换行正确转义
import { dict } from './i18n.js'; // 👈 只 import 字典对象，t/setLang 留给前端去实现

var BACKUP_RETAIN_COUNT_DEFAULT = 5;
var BACKUP_FAILED_RETAIN_COUNT_DEFAULT = 10; // 失败记录默认保留10条

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

async function getRetainCount(env) {
  try {
    const setting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_retain_count'").first();
    if (setting && setting.value) {
      const val = parseInt(setting.value, 10);
      if (Number.isFinite(val) && val >= 1) return val;
    }
  } catch (e) {
    console.warn("读取保留数量设置失败，使用默认值:", e);
  }
  return BACKUP_RETAIN_COUNT_DEFAULT;
}

async function getFailedRetainCount(env) {
  try {
    const setting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_failed_retain_count'").first();
    if (setting && setting.value !== undefined) {
      const val = parseInt(setting.value, 10);
      if (Number.isFinite(val) && val >= 0) return val;
    }
  } catch (e) {
    console.warn("读取失败记录保留数量设置失败，使用默认值:", e);
  }
  return BACKUP_FAILED_RETAIN_COUNT_DEFAULT;
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
    if (pathname === "/api/backup/trigger-status" && request.method === "GET") {
      return await handleTriggerStatus(request, env);
    }
    if (pathname === "/api/backup/sync-org" && request.method === "POST") {
      return await handleSyncOrg(request, env, ctx);
    }
    if (pathname === "/api/backup/sync-status" && request.method === "GET") {
      return await handleSyncStatus(request, env);
    }
    if (pathname === "/api/backup/cleanup-count" && request.method === "POST") {
      return await handleCountCleanup(request, env);
    }
    if (pathname === "/api/backup/cleanup" && request.method === "POST") {
      return await handleCleanupBackups(request, env, ctx);
    }
    if (pathname === "/api/backup/cleanup-status" && request.method === "GET") {
      return await handleCleanupStatus(request, env);
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
    return new Response(JSON.stringify({ success: false, errorCode: 'errMissingPassword' }),
      { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!env.ADMIN_PASSWORD || !timingSafeEqual(body.password, env.ADMIN_PASSWORD)) {
    return new Response(JSON.stringify({ success: false, errorCode: 'errPasswordWrong' }),
      { status: 401, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ success: true }),
    {
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

// ---------- 单库备份状态查询 ----------
async function handleTriggerStatus(request, env) {
  if (!isAuthed(request, env)) return Response.json({ status: "error", errorCode: "errUnauthorized" }, { status: 401 });
  if (!env.KV) return Response.json({ status: "error", errorCode: "errKvNotBound" }, { status: 500 });
  
  const result = await env.KV.get('manual_backup_result');
  if (!result) return Response.json({ status: 'pending' });
  
  await env.KV.delete('manual_backup_result');
  return Response.json(JSON.parse(result));
}

// ---------- 手动备份 ----------
async function handleTriggerBackup(request, env, ctx) {
  if (!isAuthed(request, env)) {
    return Response.json({ success: false, errorCode: "errUnauthorized" }, { status: 401 });
  }
  try {
    const body = await parseJson(request);
    const repoFullName = (body.repo || "").trim();
    const branch = (body.branch || "").trim();

    if (!repoFullName || !repoFullName.includes("/")) {
      return Response.json({ success: false, errorCode: "errRepoFormat" }, { status: 400 });
    }

    const [owner, repoName] = repoFullName.split("/");
    if (!owner || !repoName) {
      return Response.json({ success: false, errorCode: "errRepoFormat" }, { status: 400 });
    }

    // 校验仓库存在并获取默认分支
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "github-backup-worker-cloudflare"
      }
    });

    if (repoRes.status === 404) {
      return Response.json({ success: false, errorCode: 'errRepoNotFound', params: {repo: `${owner}/${repoName}`} }, { status: 404 });
    }
    if (!repoRes.ok) {
      return Response.json({ success: false, message: `GitHub API 错误: ${repoRes.status}` }, { status: 500 });
    }

    const repoInfo = await repoRes.json();
    const actualBranch = branch || repoInfo.default_branch;

    // 先写入pending状态
    if (env.KV) {
      await env.KV.delete('manual_backup_result');
      await env.KV.put('manual_backup_result', JSON.stringify({ status: 'pending' }), { expirationTtl: 300 });
    }

    // 异步执行备份
    ctx.waitUntil((async () => {
      try {
        const result = await performBackup(env, owner, repoName, actualBranch, "");
        if (env.KV) {
          await env.KV.put('manual_backup_result', JSON.stringify({
            status: result.status,
            repo: result.repo,
            branch: result.branch,
            fileName: result.fileName,
            fileSize: result.fileSize,
            message: result.message
          }), { expirationTtl: 300 });
        }
      } catch (e) {
        console.error("手动备份失败:", e);
        if (env.KV) {
          await env.KV.put('manual_backup_result', JSON.stringify({
            status: 'error',
            message: e.message
          }), { expirationTtl: 300 });
        }
      }
    })());

    return Response.json({ 
      success: true, 
      branch: actualBranch, 
      kv: !!env.KV 
    });
  } catch (e) {
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

// ---------- 组织全量备份 ----------
async function handleSyncStatus(request, env) {
  if (!isAuthed(request, env)) return Response.json({ status: "error", errorCode: "errUnauthorized" }, { status: 401 });
  if (!env.KV) return Response.json({ status: "error", errorCode: "errKvNotBound" }, { status: 500 });
  
  const result = await env.KV.get('sync_result');
  if (!result) return Response.json({ status: 'pending' });
  
  await env.KV.delete('sync_result');
  return Response.json(JSON.parse(result));
}

async function handleSyncOrg(request, env, ctx) {
  if (!isAuthed(request, env)) {
    return Response.json({ success: false, errorCode: "errUnauthorized" }, { status: 401 });
  }
  try {
    const body = await parseJson(request);
    const orgName = (body.org || "").trim();
    const limit = parseInt(body.limit, 10) || 10; 

    if (!orgName) {
      return Response.json({ success: false, errorCode: "errInputOrgName" }, { status: 400 });
    }

    const checkRes = await fetch(`https://api.github.com/orgs/${orgName}/repos?per_page=1`, {
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "github-backup-worker-cloudflare"
      }
    });

    if (checkRes.status === 404) {
      return Response.json({ success: false, errorCode: 'errOrgNotFound', params: {org: orgName} }, { status: 404 });
    }
    if (!checkRes.ok && checkRes.status !== 403) {
       return Response.json({ success: false, message: `GitHub API 错误: ${checkRes.status}` }, { status: 500 });
    }

    // 先写入pending状态
    if (env.KV) {
      await env.KV.delete('sync_result');
      await env.KV.put('sync_result', JSON.stringify({ status: 'pending' }), { expirationTtl: 300 });
    }

    ctx.waitUntil(performOrgSync(env, orgName, limit));
    return Response.json({ success: true, message: `已提交 ${orgName} 的全量备份任务（单次上限 ${limit} 个），请稍候等待完成` });
  } catch (e) {
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

async function performOrgSync(env, orgName, limit) {
  let successCount = 0;
  let failedCount = 0;
  let skipped = 0;
  try {
    // 循环前先检查熔断
    const pauseCheckStart = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_paused'").first();
    if (pauseCheckStart && pauseCheckStart.value === 'true') {
      throw new Error("备份已被熔断，任务终止");
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
    
    for (const repo of repos) {
      // 循环中每次都检查熔断
      const pauseCheck = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_paused'").first();
      if (pauseCheck && pauseCheck.value === 'true') {
        throw new Error("备份中途因 R2 存储空间不足被熔断");
      }

      if (successCount + failedCount >= limit) {
        console.log(`已达到单次备份上限 ${limit} 个，停止执行`);
        break; 
      }

      const existing = await env.DB.prepare(
        "SELECT created_at FROM backups WHERE repo_name = ? AND status IN ('done','success') ORDER BY created_at DESC LIMIT 1"
      ).bind(repo.full_name).first();

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

      console.log(`[${successCount + failedCount + 1}/${limit}] 触发备份: ${repo.full_name} (${repo.default_branch})`);
      try {
        const result = await performBackup(env, repo.owner.login, repo.name, repo.default_branch || "main", repo.clone_url);
        if (result.status === 'done') {
          successCount++;
        } else {
          failedCount++;
        }
      } catch (e) {
        console.error(`备份 ${repo.full_name} 失败:`, e);
        failedCount++;
      }
    }

    console.log(`组织备份任务结束。成功 ${successCount} 个，失败 ${failedCount} 个，跳过了 ${skipped} 个已备份仓库。`);

    // 检查是否因为空间不足被熔断
    const pauseState = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_paused'").first();
    if (pauseState && pauseState.value === 'true') {
      if (env.KV) {
        await env.KV.put('sync_result', JSON.stringify({ 
          status: 'error', 
          errorCode: 'errSyncAbortedMsg',
          params: { success: successCount, failed: failedCount }
        }), { expirationTtl: 300 });
      }
      return;
    }

    if (env.KV) {
      await env.KV.put('sync_result', JSON.stringify({ 
        status: 'done', 
        successCount: successCount,
        failedCount: failedCount,
        skipped: skipped,
        total: successCount + failedCount,
        org: orgName 
      }), { expirationTtl: 300 });
    }
  } catch (e) {
    console.error("全量备份组织失败:", e);
    if (env.KV) {
      await env.KV.put('sync_result', JSON.stringify({ 
        status: 'error', 
        message: e.message + "，已成功备份 " + successCount + " 个，失败 " + failedCount + " 个"
      }), { expirationTtl: 300 });
    }
  }
}

// ---------- 备份清理任务状态查询 ----------
async function handleCleanupStatus(request, env) {
  if (!isAuthed(request, env)) return Response.json({ status: "error", errorCode: "errUnauthorized" }, { status: 401 });
  if (!env.KV) return Response.json({ status: "error", errorCode: "errKvNotBoundCleanup" }, { status: 500 });
  
  const result = await env.KV.get('cleanup_result');
  if (!result) return Response.json({ status: 'pending' });
  
  await env.KV.delete('cleanup_result');
  return Response.json(JSON.parse(result));
}

// ---------- 统计待清理备份数量 ----------
async function handleCountCleanup(request, env) {
  if (!isAuthed(request, env)) {
    return Response.json({ success: false, errorCode: "errUnauthorized" }, { status: 401 });
  }
  try {
    const body = await parseJson(request);
    const newRetainCount = parseInt(body.backup_retain_count, 10);
    const newFailedRetainCount = parseInt(body.backup_failed_retain_count, 10);
    
    if (!Number.isFinite(newRetainCount) || newRetainCount < 1) {
      return Response.json({ success: false, errorCode: "errValidRetain" }, { status: 400 });
    }
    if (!Number.isFinite(newFailedRetainCount) || newFailedRetainCount < 0) {
      return Response.json({ success: false, errorCode: "errValidFailedRetain" }, { status: 400 });
    }

    // 查询超出保留数量的成功备份总数
    const { results: successToDelete } = await env.DB.prepare(`
      WITH RankedBackups AS (
        SELECT id, file_name,
               ROW_NUMBER() OVER (PARTITION BY repo_name, branch ORDER BY created_at DESC) as rn
        FROM backups
        WHERE status IN ('done','success')
      )
      SELECT COUNT(*) as count FROM RankedBackups WHERE rn > ?
    `).bind(newRetainCount).all();

    // 查询超出保留数量的失败记录总数
    let failedDeleteCount = 0;
    if (newFailedRetainCount === 0) {
      // 设为0时删除所有失败记录
      const { results: failedCount } = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM backups WHERE status IN ('error','failed')
      `).all();
      failedDeleteCount = failedCount[0]?.count || 0;
    } else {
      // 按仓库和分支分组，超出数量的删除
      const { results: failedToDelete } = await env.DB.prepare(`
        WITH RankedFailed AS (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY repo_name, branch ORDER BY created_at DESC) as rn
          FROM backups
          WHERE status IN ('error','failed')
        )
        SELECT COUNT(*) as count FROM RankedFailed WHERE rn > ?
      `).bind(newFailedRetainCount).all();
      failedDeleteCount = failedToDelete[0]?.count || 0;
    }

    const successDeleteCount = successToDelete[0]?.count || 0;
    const totalDeleteCount = successDeleteCount + failedDeleteCount;
    return Response.json({ 
      success: true, 
      successDeleteCount,
      failedDeleteCount,
      deleteCount: totalDeleteCount,
      willCleanup: totalDeleteCount > 0
    });
  } catch (e) {
    console.error("统计待清理备份失败:", e);
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

// ---------- 执行批量清理旧备份 ----------
async function handleCleanupBackups(request, env, ctx) {
  if (!isAuthed(request, env)) {
    return Response.json({ success: false, errorCode: "errUnauthorized" }, { status: 401 });
  }
  try {
    const body = await parseJson(request);
    const newRetainCount = parseInt(body.backup_retain_count, 10);
    const newFailedRetainCount = parseInt(body.backup_failed_retain_count, 10);
    
    if (!Number.isFinite(newRetainCount) || newRetainCount < 1) {
      return Response.json({ success: false, errorCode: "errValidRetain" }, { status: 400 });
    }
    if (!Number.isFinite(newFailedRetainCount) || newFailedRetainCount < 0) {
      return Response.json({ success: false, errorCode: "errValidFailedRetain" }, { status: 400 });
    }

    // 先写入pending状态
    if (env.KV) {
      await env.KV.delete('cleanup_result');
      await env.KV.put('cleanup_result', JSON.stringify({ status: 'pending' }), { expirationTtl: 600 });
    }

    // 异步执行清理任务
    ctx.waitUntil(performCleanupBackups(env, newRetainCount, newFailedRetainCount));
    
    return Response.json({ 
      success: true, 
      errorCode: "errCleanupSubmitted",
      kv: !!env.KV
    });
  } catch (e) {
    console.error("提交清理任务失败:", e);
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

async function performCleanupBackups(env, retainCount, failedRetainCount) {
  let deletedSuccessCount = 0;
  let deletedFailedCount = 0;
  let failedCount = 0;
  let errorMsg = "";
  try {
    // 先保存新的保留数量到设置
    await env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_retain_count', ?)"
    ).bind(retainCount.toString()).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_failed_retain_count', ?)"
    ).bind(failedRetainCount.toString()).run();

    // ========== 清理成功备份 ==========
    const { results: successToDelete } = await env.DB.prepare(`
      WITH RankedBackups AS (
        SELECT id, file_name, file_size,
               ROW_NUMBER() OVER (PARTITION BY repo_name, branch ORDER BY created_at DESC) as rn
        FROM backups
        WHERE status IN ('done','success')
      )
      SELECT id, file_name FROM RankedBackups WHERE rn > ? ORDER BY rn ASC
    `).bind(retainCount).all();

    const totalSuccessToDelete = successToDelete.length;
    for (const backup of successToDelete) {
      try {
        await env.BUCKET.delete(backup.file_name);
        await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(backup.id).run();
        deletedSuccessCount++;
      } catch (e) {
        console.error(`[批量清理] 删除成功备份失败: ${backup.file_name}`, e);
        failedCount++;
      }
    }

    // ========== 清理失败记录 ==========
    let failedToDelete = [];
    if (failedRetainCount === 0) {
      // 设为0删除所有失败记录（失败记录没有R2文件，只删数据库行）
      const { results } = await env.DB.prepare(`
        SELECT id FROM backups WHERE status IN ('error','failed') ORDER BY created_at ASC
      `).all();
      failedToDelete = results;
    } else {
      // 按保留数量删除超出的失败记录
      const { results } = await env.DB.prepare(`
        WITH RankedFailed AS (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY repo_name, branch ORDER BY created_at DESC) as rn
          FROM backups
          WHERE status IN ('error','failed')
        )
        SELECT id FROM RankedFailed WHERE rn > ? ORDER BY rn ASC
      `).bind(failedRetainCount).all();
      failedToDelete = results;
    }

    const totalFailedToDelete = failedToDelete.length;
    for (const record of failedToDelete) {
      try {
        await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(record.id).run();
        deletedFailedCount++;
      } catch (e) {
        console.error(`[批量清理] 删除失败记录失败，id: ${record.id}`, e);
        failedCount++;
      }
    }

    const totalDeleted = deletedSuccessCount + deletedFailedCount;
    let resultMsg = `清理完成：成功删除 ${totalDeleted} 条记录`;
    const details = [];
    if (deletedSuccessCount > 0) details.push(`成功备份 ${deletedSuccessCount} 个`);
    if (deletedFailedCount > 0) details.push(`失败记录 ${deletedFailedCount} 条`);
    if (details.length > 0) resultMsg += `（${details.join('，')}）`;
    if (failedCount > 0) resultMsg += `，${failedCount} 条删除失败`;

    const result = {
      status: 'done',
      deletedCount: totalDeleted,
      deletedSuccessCount,
      deletedFailedCount,
      failedCount,
      message: resultMsg
    };

    if (env.KV) {
      await env.KV.put('cleanup_result', JSON.stringify(result), { expirationTtl: 300 });
    }
    console.log(resultMsg);
  } catch (e) {
    console.error("批量清理备份失败:", e);
    errorMsg = e.message;
    if (env.KV) {
      await env.KV.put('cleanup_result', JSON.stringify({
        status: 'error',
        message: `清理失败：${errorMsg}，已成功删除 ${deletedSuccessCount + deletedFailedCount} 条记录`
      }), { expirationTtl: 300 });
    }
  }
}

// ---------- 旧备份清理（单库备份完成后自动执行） ----------
async function cleanupOldBackups(env, repoFullName, branch) {
  try {
    const retainCount = await getRetainCount(env);
    const { results: oldBackups } = await env.DB.prepare(`
      SELECT id, file_name FROM backups 
      WHERE repo_name = ? AND branch = ? AND status IN ('done','success')
      ORDER BY created_at DESC
      LIMIT -1 OFFSET ?
    `).bind(repoFullName, branch, retainCount).all();
    
    for (const backup of oldBackups) {
      try {
        await env.BUCKET.delete(backup.file_name);
        await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(backup.id).run();
        console.log(`[清理旧备份] 已删除超出保留数量的旧备份: ${backup.file_name}`);
      } catch (e) {
        console.error(`[清理旧备份] 删除失败: ${backup.file_name}`, e);
      }
    }

    // 同时清理超出数量的失败记录
    const failedRetainCount = await getFailedRetainCount(env);
    let failedRecordsToDelete = [];
    if (failedRetainCount === 0) {
      // 保留0条时删除当前仓库该分支的所有失败记录
      const { results } = await env.DB.prepare(`
        SELECT id FROM backups 
        WHERE repo_name = ? AND branch = ? AND status IN ('error','failed')
        ORDER BY created_at ASC
      `).bind(repoFullName, branch).all();
      failedRecordsToDelete = results;
    } else {
      // 保留指定数量，删除超出的
      const { results } = await env.DB.prepare(`
        SELECT id FROM backups 
        WHERE repo_name = ? AND branch = ? AND status IN ('error','failed')
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      `).bind(repoFullName, branch, failedRetainCount).all();
      failedRecordsToDelete = results;
    }
    
    for (const record of failedRecordsToDelete) {
      try {
        await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(record.id).run();
        console.log(`[清理失败记录] 已删除超出保留数量的失败记录，id: ${record.id}`);
      } catch (e) {
        console.error(`[清理失败记录] 删除失败，id: ${record.id}`, e);
      }
    }
  } catch (e) {
    console.error("清理旧备份失败:", e);
  }
}

// ---------- 备份执行 ----------
async function performBackup(env, owner, repoName, branch, cloneUrl) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${owner}-${repoName}-${branch}-${timestamp}.tar.gz`;
  const repoFullName = `${owner}/${repoName}`;
  let status = "error";
  let errorMsg = "";
  let fileSize = 0;
  try {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
    if (!env.BUCKET) throw new Error("R2 BUCKET binding is missing");

    // 提前检查熔断状态
    const pauseCheck = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_paused'").first();
    if (pauseCheck && pauseCheck.value === 'true') {
      throw new Error("可用空间不足，已暂停所有备份功能。请手动清理历史备份并在管理面板点击恢复。");
    }

    // 只要当前已用空间 + 100KB 超过上限，就会触发熔断
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

    // 调用容量检查
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
      await checkAndCleanSpace(env, fileSize);
      await env.BUCKET.put(fileName, new Uint8Array(buf), {
        httpMetadata: { contentType: "application/gzip" }
      });
    }

    status = "done";
    errorMsg = "备份成功";
    console.log(`Backup successful: ${fileName}, size: ${fileSize} bytes`);
  } catch (e) {
    status = "error";
    errorMsg = e.message;
    console.error(`Backup failed for ${repoFullName}: ${errorMsg}`, e.stack || "");
  } finally {
    try {
      if (env.DB) {
        await env.DB.prepare(
          "INSERT INTO backups (repo_name, branch, file_name, file_size, status, error_msg, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(repoFullName, branch, fileName, fileSize, status, errorMsg, new Date().toISOString()).run();
        // 无论成功还是失败，都执行清理（成功备份清理旧成功备份，失败记录清理旧失败记录）
        await cleanupOldBackups(env, repoFullName, branch);
      } else {
        console.warn("D1 DB binding is missing, skipping log entry.");
      }
    } catch (dbError) {
      console.error("Failed to log to D1:", dbError);
      if (!errorMsg) errorMsg = dbError.message;
      status = "error";
    }
  }

  return {
    status,
    repo: repoFullName,
    branch,
    fileName,
    fileSize,
    message: errorMsg
  };
}

async function checkAndCleanSpace(env, incomingSize = 0) {
  const setting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'r2_max_gb'").first();
  const maxGB = parseFloat(setting ? setting.value : "8");
  const maxBytes = maxGB * 1024 * 1024 * 1024;
  
  const { total } = await env.DB.prepare(
    "SELECT SUM(file_size) as total FROM backups WHERE status IN ('done','success')"
  ).first();
  let currentSize = total || 0;

  // 如果空间够了，按需自动解除熔断（只在当前是熔断状态时才写，避免每次都产生无谓写入）
  if (currentSize + incomingSize <= maxBytes) {
    const pauseCheck = await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_paused'").first();
    if (pauseCheck && pauseCheck.value === 'true') {
      await env.DB.prepare("UPDATE settings SET value = 'false' WHERE key = 'backup_paused'").run();
    }
    return;
  }

  // 如果空间不够，且已经熔断了，就拦截
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
      WHERE status IN ('done','success')
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
    return new Response(loginPageHtml(dict), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      status: 200
    });
  }
  return new Response(adminPageHtml(dict), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    status: 200
  });
}

function loginPageHtml(dict) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>GitHub Backup Admin</title></head>
<body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f2f5;">
  <div style="background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);position:relative;">
    <div style="position:absolute;top:1rem;right:1rem;display:flex;gap:4px;" class="lang-switcher">
      <button id="langZh" onclick="setLang('zh')" data-i18n="zh" data-lang-btn="zh" style="padding:4px 10px;border:1px solid #ccc;border-radius:4px;cursor:pointer;"></button>
      <button id="langEn" onclick="setLang('en')" data-i18n="en" data-lang-btn="en" style="padding:4px 10px;border:1px solid #ccc;border-radius:4px;cursor:pointer;"></button>
    </div>
    <h2 id="loginTitle" data-i18n="loginTitle"></h2>
    <input id="pw" type="password" data-i18n-placeholder="passwordPlaceholder" style="padding:8px;margin-right:8px;border:1px solid #ccc;border-radius:4px;" />
    <button onclick="login()" id="loginBtn" data-i18n="loginBtn" style="padding:8px 16px;background:#007bff;color:#fff;border:none;border-radius:4px;cursor:pointer;"></button>
    <p id="msg" style="color:red;min-height:1em;"></p>
  </div>
  <script>
    const dict = ${JSON.stringify(dict)};
    let currentLang = 'zh';
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('backup_manager_lang');
      if (saved && dict[saved]) currentLang = saved;
    }
    function t(key, params) {
      params = params || {};
      let text = (dict[currentLang] && dict[currentLang][key]) || dict.zh[key] || key;
      Object.keys(params).forEach(k => { text = text.split('{' + k + '}').join(params[k]); });
      return text;
    }
    function setLang(lang) {
      if (!dict[lang]) return;
      currentLang = lang;
      if (typeof localStorage !== 'undefined') localStorage.setItem('backup_manager_lang', lang);
      if (typeof window.applyLoginLang === 'function') window.applyLoginLang();
    }
    function getLang() { return currentLang; }

    function applyLoginLang() {
      const lang = getLang();
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      // 统一遍历所有带data-i18n的元素
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key === 'zh' || key === 'en') return; // 跳过语言按钮自己，统一处理高亮
        el.textContent = t(key);
      });
      // 统一遍历所有带data-i18n-placeholder的元素
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = t(key);
      });
      // 语言按钮文字和高亮统一处理
      const langMap = { zh: '中文', en: 'EN' };
      document.querySelectorAll('[data-lang-btn]').forEach(btn => {
        const btnLang = btn.getAttribute('data-lang-btn');
        btn.textContent = langMap[btnLang] || btnLang;
        if (btnLang === lang) {
          btn.style.background = '#007bff';
          btn.style.color = '#fff';
        } else {
          btn.style.background = '#fff';
          btn.style.color = '#333';
        }
      });
    }
    window.applyLoginLang = applyLoginLang;

    async function login() {
      const pw = document.getElementById('pw').value;
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      if (res.ok) { location.reload(); }
      else { document.getElementById('msg').textContent = t('wrongPassword'); }
    }
    document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    applyLoginLang();
  <\/script>
</body></html>`;
}

function adminPageHtml(dict) {
  return `<!DOCTYPE html>
<!-- v2.20 -->
<html lang="zh-CN"><head><meta charset="UTF-8"><title>备份日志管理</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:20px;background:#f6f8fa;}
  .container{max-width:1200px;margin:0 auto;background:#fff;padding:20px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);}
  h1{color:#24292e;}
  table{width:100%;border-collapse:collapse;margin-top:20px;table-layout:fixed;}
  th,td{padding:12px;text-align:left;border-bottom:1px solid #e1e4e8;word-break:break-all;}
  th{background:#f6f8fa;font-weight:600;}
  .status-success{color:#28a745;font-weight:bold;}
  .status-failed{color:#d73a49;font-weight:bold;}
  .refresh-btn{background:#007bff;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;}
  .btn{padding:4px 10px;border:none;border-radius:4px;cursor:pointer;font-size:14px;color:#fff;text-decoration:none;display:inline-block;margin-right:6px;}
  .btn-download{background:#28a745;}
  .btn-delete{background:#d73a49;}
  .btn:disabled{opacity:.6;cursor:not-allowed;}
  .col-time{width:130px;}.col-repo{width:120px;}.col-branch{width:90px;}.col-size{width:80px;}.col-status{width:70px;}.col-action{width:120px;}
  .col-file{width: 250px; word-break: break-all;}
  .col-msg{width: 150px; word-break: break-all;}
  .setting-item{margin-right: 16px;}
</style></head>
<body>
<div class="container">
  <!-- 顶部标题栏 -->
  <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e1e4e8; padding-bottom: 12px; margin-bottom: 20px;">
    <h1 style="margin: 0; font-size: 24px; color: #24292e;" data-i18n="headerTitle">GitHub 仓库备份管理</h1>
    <span style="background: #e1e4e8; color: #586069; padding: 4px 10px; border-radius: 12px; font-size: 13px; font-weight: 600;">v2.21</span>
  </div>

  <div id="pauseWarning" style="margin-bottom: 20px; padding: 15px; background: #ffebe9; border: 1px solid #ff8182; border-radius: 6px; color: #d73a49; display: none; justify-content: space-between; align-items: center;">
    <strong id="pauseWarningText" data-i18n="pauseWarning"></strong>
    <button id="resumeBtn" onclick="resumeBackups()" data-i18n="resumeBackup" style="padding: 6px 16px; background: #d73a49; color: #fff; border: none; border-radius: 4px; cursor: pointer;"></button>
  </div>

  <div style="margin-top: 20px; padding: 12px; background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
    <strong id="manualBackupTitle" data-i18n="manualBackupTitle"></strong>
    <input id="manualRepo" type="text" data-i18n-placeholder="manualRepoPlaceholder" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 300px;" />
    <input id="manualBranch" type="text" data-i18n-placeholder="manualBranchPlaceholder" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 220px;" />
    <button id="startBackupBtn" onclick="triggerManualBackup()" data-i18n="startBackup" style="padding: 6px 16px; background: #007bff; color: #fff; border: none; border-radius: 4px; cursor: pointer;"></button>
    <button class="refresh-btn" id="refreshBtn" onclick="loadLogs()" data-i18n="refreshLogs" style="margin-left:auto;"></button>
    <button class="refresh-btn" id="logoutBtn" style="background:#6c757d;" onclick="logout()" data-i18n="logout"></button>
  </div>
  <div style="margin-top: 16px; padding: 12px; background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
    <strong id="fullBackupTitle" data-i18n="fullBackupTitle"></strong>
    <input id="syncOrgName" type="text" data-i18n-placeholder="orgPlaceholder" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 180px;" />
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;" class="setting-item">
      <span id="maxPerRunLabel" data-i18n="maxPerRun"></span>
      <input id="syncLimit" type="number" value="10" min="1" max="100" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 60px;" />
      <span id="unitLabel" data-i18n="unit"></span>
    </label>
    <button id="startFullBackupBtn" onclick="syncOrganization()" data-i18n="startFullBackup" style="padding: 6px 16px; background: #d73a49; color: #fff; border: none; border-radius: 4px; cursor: pointer;"></button>
    <span id="fullBackupHint" data-i18n="fullBackupHint" style="font-size: 12px; color: #666; width: 100%;"></span>
  </div>
  <div style="margin-top: 16px; padding: 12px; background: #eef2f5; border: 1px solid #cbd5e1; border-radius: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
    <strong id="settingsTitle" data-i18n="settingsTitle"></strong>
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;" class="setting-item">
      <span id="r2MaxSpaceLabel" data-i18n="r2MaxSpace"></span>
      <input id="r2MaxGb" type="number" step="0.5" value="8" min="1" max="1000" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 80px;" />
      <span id="gbUnitLabel" data-i18n="gbUnit"></span>
    </label>
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;" class="setting-item">
      <span id="retainCountLabel" data-i18n="retainCount"></span>
      <input id="backupRetainCount" type="number" value="5" min="1" max="100" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 60px;" />
      <span id="backupsUnitLabel" data-i18n="backupsUnit"></span>
    </label>
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;" class="setting-item">
      <span id="failedRetainCountLabel" data-i18n="failedRetainCount"></span>
      <input id="failedRetainCount" type="number" value="10" min="0" max="10000" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 70px;" />
      <span id="recordsUnitLabel" data-i18n="recordsUnit"></span>
    </label>
    <button id="saveSettingsBtn" onclick="saveSettings()" data-i18n="save" style="padding: 6px 16px; background: #475569; color: #fff; border: none; border-radius: 4px; cursor: pointer;"></button>
    <span id="settingsHint" data-i18n="settingsHint" style="font-size: 12px; color: #666; width: 100%;"></span>
  </div>
  <div style="margin-top: 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
    <div style="display: flex; align-items: center; gap: 8px;">
      <label for="repoFilter" id="filterRepoLabel" data-i18n="filterRepo" style="font-weight: 600; color: #24292e;"></label>
      <select id="repoFilter" onchange="renderTable()" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
        <option value="" data-i18n="allRepos"></option>
      </select>
    </div>
    <div style="display: flex; align-items: center; gap: 8px;">
      <label for="ownerFilter" id="filterOwnerLabel" data-i18n="filterOwner" style="font-weight: 600; color: #24292e;"></label>
      <select id="ownerFilter" onchange="renderTable()" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
        <option value="" data-i18n="allOwners"></option>
      </select>
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <h1 id="pageTitle" style="margin: 0; font-size: 22px;"></h1>
      <div style="display:flex; gap:4px;" class="lang-switcher">
        <button id="langZh" onclick="setLang('zh')" data-lang-btn="zh" style="padding:4px 10px;border:1px solid #ccc;border-radius:4px;cursor:pointer;"></button>
        <button id="langEn" onclick="setLang('en')" data-lang-btn="en" style="padding:4px 10px;border:1px solid #ccc;border-radius:4px;cursor:pointer;"></button>
      </div>
    </div>
  </div>
  <div style="overflow-x: auto;">
    <table id="logTable">
      <thead><tr>
        <th class="col-time" data-i18n="tableTime"></th>
        <th class="col-repo" data-i18n="tableRepo"></th>
        <th class="col-branch" data-i18n="tableBranch"></th>
        <th class="col-file" data-i18n="tableFileName"></th> <!-- 加上了 class="col-file" -->
        <th class="col-size" data-i18n="tableSize"></th>
        <th class="col-status" data-i18n="tableStatus"></th>
        <th class="col-msg" data-i18n="tableError"></th>
        <th class="col-action" data-i18n="tableAction"></th>
      </tr></thead>
      <tbody><tr><td colspan="8" data-i18n="loading"></td></tr></tbody>
    </table>
  </div>
<script>
    const dict = ${JSON.stringify(dict)};
    let currentLang = 'zh';
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('backup_manager_lang');
      if (saved && dict[saved]) currentLang = saved;
    }
    function t(key, params) {
      params = params || {};
      let text = (dict[currentLang] && dict[currentLang][key]) || dict.zh[key] || key;
      Object.keys(params).forEach(k => { text = text.split('{' + k + '}').join(params[k]); });
      return text;
    }
    function setLang(lang) {
      if (!dict[lang]) return;
      currentLang = lang;
      if (typeof localStorage !== 'undefined') localStorage.setItem('backup_manager_lang', lang);
      if (typeof window.applyLang === 'function') window.applyLang();
    }
    function getLang() { return currentLang; }

    let allLogs = [];
    let isPolling = false;

    function formatSize(bytes){ if(!bytes||bytes===0) return t('unknown'); const u=['B','KB','MB','GB']; const i=Math.floor(Math.log(bytes)/Math.log(1024)); return (bytes/Math.pow(1024,i)).toFixed(2)+' '+u[i]; }

    function applyLang() {
      const lang = getLang();
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      // 统一处理所有静态文本：data-i18n 属性
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        // 跳过语言按钮（在下面统一处理高亮）
        if (key === 'zh' || key === 'en') return;
        // pageTitle 特殊处理，加版本号
        if (key === 'pageTitle') {
          el.textContent = t(key) + ' v2.20';
          return;
        }
        el.textContent = t(key);
      });
      // 统一处理 placeholder
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = t(key);
      });
      // 统一处理语言按钮文字和高亮
      const langMap = { zh: '中文', en: 'EN' };
      document.querySelectorAll('[data-lang-btn]').forEach(btn => {
        const btnLang = btn.getAttribute('data-lang-btn');
        btn.textContent = langMap[btnLang] || btnLang;
        if (btnLang === lang) {
          btn.style.background = '#007bff';
          btn.style.color = '#fff';
        } else {
          btn.style.background = '#fff';
          btn.style.color = '#333';
        }
      });
      // 重新生成仓库下拉选项（翻译"全部仓库"）
      const select = document.getElementById('repoFilter');
      const currentVal = select.value;
      select.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = t('allRepos');
      select.appendChild(allOpt);
      const repos = [...new Set(allLogs.map(l => l.repo_name).filter(Boolean))].sort();
      repos.forEach(repo => {
        const opt = document.createElement('option');
        opt.value = repo;
        opt.textContent = repo;
        select.appendChild(opt);
      });
      if (repos.includes(currentVal)) select.value = currentVal;

      const ownerSelect = document.getElementById('ownerFilter');
      const currentOwnerVal = ownerSelect.value;
      const owners = [...new Set(allLogs.map(l => {
        if (!l.repo_name) return null;
        return l.repo_name.split('/')[0];
      }).filter(Boolean))].sort();

      ownerSelect.innerHTML = '<option value="">' + t('allOwners') + '</option>';
      owners.forEach(owner => {
        const opt = document.createElement('option');
        opt.value = owner; opt.textContent = owner; ownerSelect.appendChild(opt);
      });
      if (owners.includes(currentOwnerVal)) ownerSelect.value = currentOwnerVal;

      // 重新渲染表格（用当前最新语言）
      renderTable();
    }
    window.applyLang = applyLang;

    async function logout(){ await fetch('/logout',{method:'POST'}); location.reload(); }

    async function deleteBackup(fileName, btn){
      if(!confirm(t('confirmDelete', {name: fileName}))) return;
      btn.disabled = true; btn.textContent = t('deleting');
      try {
        const res = await fetch('/api/backup/delete?file=' + encodeURIComponent(fileName), { method:'DELETE' });
        const result = await res.json();
        if (result.success) { alert(t('deleteSuccess')); loadLogs(); }
        else { alert(t('deleteFailed') + (result.message || t('unknownError'))); btn.disabled = false; btn.textContent = t('delete'); }
      } catch(e) { alert(t('deleteFailed') + e.message); btn.disabled = false; btn.textContent = t('delete'); }
    }

    async function loadLogs(){
      try {
        const setRes = await fetch('/api/settings');
        const setData = await setRes.json();
        const isPaused = setData.settings && setData.settings.backup_paused === 'true';
        document.getElementById('pauseWarning').style.display = isPaused ? 'flex' : 'none';
        document.getElementById('startBackupBtn').disabled = isPaused;
        document.getElementById('startFullBackupBtn').disabled = isPaused;
        const res = await fetch('/api/logs');
        if (res.status === 401) { location.reload(); return; }
        const data = await res.json();
        allLogs = data.logs || [];
        const select = document.getElementById('repoFilter');
        const currentVal = select.value;
        const repos = [...new Set(allLogs.map(l => l.repo_name).filter(Boolean))].sort();
        select.innerHTML = '<option value="">' + t('allRepos') + '</option>';
        repos.forEach(repo => {
          const opt = document.createElement('option');
          opt.value = repo; opt.textContent = repo; select.appendChild(opt);
        });
        if (repos.includes(currentVal)) select.value = currentVal;

        const ownerSelect = document.getElementById('ownerFilter');
        const currentOwnerVal = ownerSelect.value;
        // 提取唯一的 owner（repo_name 格式为 "owner/repo"）
        const owners = [...new Set(allLogs.map(l => {
          if (!l.repo_name) return null;
          return l.repo_name.split('/')[0];
        }).filter(Boolean))].sort();
        
        ownerSelect.innerHTML = '<option value="">' + t('allOwners') + '</option>';
        owners.forEach(owner => {
          const opt = document.createElement('option');
          opt.value = owner; opt.textContent = owner; ownerSelect.appendChild(opt);
        });
        if (owners.includes(currentOwnerVal)) ownerSelect.value = currentOwnerVal;

        renderTable();
      } catch(e) {
        console.error(e);
        document.querySelector('#logTable tbody').innerHTML = '<tr><td colspan="8">' + t('loadLogsFailed') + '</td></tr>';
      }
    }

    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        if (res.status === 401) return;
        const data = await res.json();
        if (data.success) {
          if (data.settings.r2_max_gb) document.getElementById('r2MaxGb').value = data.settings.r2_max_gb;
          if (data.settings.backup_retain_count) document.getElementById('backupRetainCount').value = data.settings.backup_retain_count;
          if (data.settings.backup_failed_retain_count !== undefined) document.getElementById('failedRetainCount').value = data.settings.backup_failed_retain_count;
        }
      } catch(e) { console.error(t('loadSettingsFailed'), e); }
    }

    async function saveSettings() {
      const r2MaxGbVal = document.getElementById('r2MaxGb').value;
      const retainCountVal = document.getElementById('backupRetainCount').value;
      const failedRetainCountVal = document.getElementById('failedRetainCount').value;
      const newRetainCount = parseInt(retainCountVal, 10);
      const newFailedRetainCount = parseInt(failedRetainCountVal, 10);
      if (!r2MaxGbVal || parseFloat(r2MaxGbVal) < 1) return alert(t('inputValidR2'));
      if (!Number.isFinite(newRetainCount) || newRetainCount < 1) return alert(t('inputValidRetain'));
      if (!Number.isFinite(newFailedRetainCount) || newFailedRetainCount < 0) return alert(t('inputValidFailedRetain'));
      const btn = document.getElementById('saveSettingsBtn');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = t('saving');
      try {
        const countRes = await fetch('/api/backup/cleanup-count', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ backup_retain_count: newRetainCount, backup_failed_retain_count: newFailedRetainCount })
        });
        const countData = await countRes.json();
        if (!countData.success) throw new Error(countData.message || t('countCleanupFailed'));
        const successDeleteCount = countData.successDeleteCount;
        const failedDeleteCount = countData.failedDeleteCount;
        const totalDeleteCount = countData.deleteCount;
        if (totalDeleteCount > 0) {
          let confirmMsg = t('cleanupConfirmTitle');
          if (successDeleteCount > 0) confirmMsg += t('cleanupSuccessItem', {count: successDeleteCount});
          if (failedDeleteCount > 0) {
            if (newFailedRetainCount === 0) confirmMsg += t('cleanupFailedAllItem', {count: failedDeleteCount});
            else confirmMsg += t('cleanupFailedItem', {count: failedDeleteCount});
          }
          confirmMsg += t('cleanupConfirmEnd', {count: totalDeleteCount});
          if (!confirm(confirmMsg)) { btn.disabled = false; btn.textContent = originalText; return; }
          const cleanupRes = await fetch('/api/backup/cleanup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backup_retain_count: newRetainCount, backup_failed_retain_count: newFailedRetainCount })
          });
          const cleanupResult = await cleanupRes.json();
          if (!cleanupResult.success) throw new Error(cleanupResult.message || t('submitCleanupFailed'));
          btn.textContent = t('cleaningUp');
          pollCleanupStatus(btn, originalText, parseFloat(r2MaxGbVal));
          return;
        }
        const saveRes = await fetch('/api/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ r2_max_gb: parseFloat(r2MaxGbVal), backup_retain_count: newRetainCount, backup_failed_retain_count: newFailedRetainCount })
        });
        const saveResult = await saveRes.json();
        if (saveResult.success) { alert(t('settingsSavedNoCleanup')); loadLogs(); }
        else alert(t('saveFailed') + saveResult.message);
      } catch(e) { alert(t('operationFailed') + e.message); }
      finally { btn.disabled = false; btn.textContent = originalText; }
    }

    async function pollCleanupStatus(btn, originalText, r2MaxGb) {
      let attempts = 0;
      const poll = async () => {
        try {
          attempts++;
          if (attempts > 60) {
            alert(t('cleanupTimeout')); btn.disabled = false; btn.textContent = originalText; loadLogs(); return;
          }
          const res = await fetch('/api/backup/cleanup-status');
          const data = await res.json();
          if (data.status === 'pending') {
            btn.textContent = t('cleaningUp') + ' (' + (attempts * 3) + 's)';
            setTimeout(poll, 3000);
          } else if (data.status === 'done') {
            await fetch('/api/settings', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ r2_max_gb: r2MaxGb, backup_failed_retain_count: parseInt(document.getElementById('failedRetainCount').value, 10) })
            });
            alert(t('settingsSaved') + data.message);
            btn.disabled = false; btn.textContent = originalText; loadLogs();
          } else if (data.status === 'error') {
            alert(t('cleanupFailed') + data.message);
            btn.disabled = false; btn.textContent = originalText; loadLogs();
          }
        } catch (e) { console.error(t('cleanupTimeout'), e); setTimeout(poll, 3000); }
      };
      poll();
    }

    async function resumeBackups() {
      if (!confirm(t('confirmResume'))) return;
      try {
        const res = await fetch('/api/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ backup_paused: 'false' })
        });
        const result = await res.json();
        if (result.success) { alert(t('resumeSuccess')); location.reload(); }
        else alert(t('resumeFailed') + result.message);
      } catch (e) { alert(t('requestFailed') + e.message); }
    }

    async function triggerManualBackup() {
      const repo = document.getElementById('manualRepo').value.trim();
      const branch = document.getElementById('manualBranch').value.trim();
      if (!repo || !repo.includes('/')) { alert(t('inputValidRepo')); return; }
      const btn = document.getElementById('startBackupBtn');
      btn.disabled = true; btn.textContent = t('verifyingRepo');
      try {
        const res = await fetch('/api/backup/trigger', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, branch })
        });
        const result = await res.json();
        if (result.success) {
          btn.textContent = t('backingUp') + ' (' + result.branch + ')...';
          pollManualStatus(btn);
        } else {
          alert(t('submitFailed') + result.message);
          btn.disabled = false; btn.textContent = t('startBackup');
        }
      } catch (e) {
        alert(t('requestFailed') + e.message);
        btn.disabled = false; btn.textContent = t('startBackup');
      }
    }

    async function pollManualStatus(btn) {
      let attempts = 0;
      const poll = async () => {
        try {
          attempts++;
          if (attempts > 60) {
            alert(t('backupTimeout')); btn.disabled = false; btn.textContent = t('startBackup'); loadLogs(); return;
          }
          const res = await fetch('/api/backup/trigger-status');
          const data = await res.json();
          if (data.status === 'pending') setTimeout(poll, 3000);
          else if (data.status === 'done') {
            alert(t('backupSuccess', {repo: data.repo, branch: data.branch, size: formatSize(data.fileSize)}));
            document.getElementById('manualRepo').value = '';
            document.getElementById('manualBranch').value = '';
            btn.disabled = false; btn.textContent = t('startBackup'); loadLogs();
          } else if (data.status === 'error') {
            alert(t('backupFailed') + data.message);
            btn.disabled = false; btn.textContent = t('startBackup'); loadLogs();
          }
        } catch (e) { console.error(t('backupTimeout'), e); setTimeout(poll, 3000); }
      };
      setTimeout(poll, 2000);
    }

    async function syncOrganization() {
      const org = document.getElementById('syncOrgName').value.trim();
      const limit = document.getElementById('syncLimit').value || 10;
      if (!org) { alert(t('inputOrgName')); return; }
      if (!confirm(t('confirmFullBackup', {org: org, limit: limit}))) return;
      const btn = document.getElementById('startFullBackupBtn');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = t('runningInBackground');
      btn.setAttribute('data-poll-attempts', '0');
      isPolling = false;
      try {
        const res = await fetch('/api/backup/sync-org', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org, limit: parseInt(limit, 10) })
        });
        const result = await res.json();
        if (result.success) {
          if (!isPolling) { isPolling = true; pollSyncStatus(btn, originalText); }
        } else {
          alert(t('submitFailed') + result.message);
          btn.disabled = false; btn.textContent = originalText; loadLogs();
        }
      } catch (e) {
        alert(t('requestFailed') + e.message);
        btn.disabled = false; btn.textContent = originalText; loadLogs();
      }
    }

    async function pollSyncStatus(btn, originalText) {
      try {
        const res = await fetch('/api/backup/sync-status');
        const data = await res.json();
        if (data.status === 'pending') {
          const attempts = parseInt(btn.getAttribute('data-poll-attempts') || '0', 10);
          if (attempts >= 60) {
            isPolling = false; btn.disabled = false; btn.textContent = originalText;
            alert(t('fullBackupTimeout')); loadLogs(); return;
          }
          btn.setAttribute('data-poll-attempts', attempts + 1);
          setTimeout(() => pollSyncStatus(btn, originalText), 3000);
        } else if (data.status === 'done') {
          isPolling = false; btn.disabled = false; btn.textContent = originalText;
          alert(t('fullBackupComplete', {success: data.successCount, failed: data.failedCount, skipped: data.skipped}));
          loadLogs();
        } else if (data.status === 'error') {
          isPolling = false; btn.disabled = false; btn.textContent = originalText;
          alert(t('fullBackupFailed') + data.message); loadLogs();
        }
      } catch (e) { console.error(t('fullBackupTimeout'), e); setTimeout(() => pollSyncStatus(btn, originalText), 3000); }
    }

    function renderTable(){
      const tbody = document.querySelector('#logTable tbody');
      tbody.innerHTML = '';
      
      // 👇 获取两个筛选条件
      const selectedRepo = document.getElementById('repoFilter').value;
      const selectedOwner = document.getElementById('ownerFilter').value;

      // 过滤逻辑：同时满足作者和仓库条件
      const filteredLogs = allLogs.filter(log => {
        if (!log.repo_name) return !selectedRepo && !selectedOwner; // 如果 repo_name 为空，只有两个筛选都没选时才显示
        const [owner] = log.repo_name.split('/');
        const matchRepo = !selectedRepo || log.repo_name === selectedRepo;
        const matchOwner = !selectedOwner || owner === selectedOwner;
        return matchRepo && matchOwner;
      });

      if (filteredLogs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8">' + t('noRecords') + '</td></tr>';
        return;
      }

      const lang = getLang();
      filteredLogs.forEach(log => {
        const tr = document.createElement('tr');
        const isSuccess = log.status === 'done' || log.status === 'success';
        let statusText = isSuccess ? t('success') : ((log.status === 'error' || log.status === 'failed') ? t('failed') : t('unknownStatus'));
        const dateStr = log.created_at ? new Date(log.created_at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') : '-';
        const cells = [
          dateStr, log.repo_name || '-', log.branch || '-', log.file_name || '-',
          formatSize(log.file_size), statusText, log.error_msg || '-'
        ];
        cells.forEach((v,i) => {
          const td = document.createElement('td');
          td.textContent = v;
          if (i === 5) td.className = isSuccess ? 'status-success' : 'status-failed';
          tr.appendChild(td);
        });
        const tdAction = document.createElement('td');
        if (log.file_name) {
          if (isSuccess) {
            const a = document.createElement('a');
            a.href = '/api/backup/download?file=' + encodeURIComponent(log.file_name);
            a.className = 'btn btn-download'; a.textContent = t('download');
            tdAction.appendChild(a);
          }
          const b = document.createElement('button');
          b.className = 'btn btn-delete'; b.textContent = t('delete');
          b.onclick = () => deleteBackup(log.file_name, b);
          tdAction.appendChild(b);
        } else tdAction.textContent = '-';
        tr.appendChild(tdAction);
        tbody.appendChild(tr);
      });
    }

    applyLang();
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
  if (!isAuthed(request, env)) return Response.json({ success: false, errorCode: "errUnauthorized" }, { status: 401 });
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
    const settings = {};
    for (const row of results) {
      settings[row.key] = row.value;
    }
    // 如果没有设置过保留数量，返回默认值
    if (!settings.backup_retain_count) {
      settings.backup_retain_count = BACKUP_RETAIN_COUNT_DEFAULT.toString();
    }
    if (settings.backup_failed_retain_count === undefined) {
      settings.backup_failed_retain_count = BACKUP_FAILED_RETAIN_COUNT_DEFAULT.toString();
    }
    return Response.json({ success: true, settings });
  } catch (e) {
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

// 保存设置
async function handleSaveSettings(request, env) {
  if (!isAuthed(request, env)) return Response.json({ success: false, errorCode: "errUnauthorized" }, { status: 401 });
  try {
    const body = await parseJson(request);
    if (body.backup_paused === 'false' || body.r2_max_gb !== undefined) {
      await env.DB.prepare("UPDATE settings SET value = 'false' WHERE key = 'backup_paused'").run();
    }

    if (body.r2_max_gb !== undefined) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('r2_max_gb', ?)"
      ).bind(body.r2_max_gb.toString()).run();
    }

    if (body.backup_retain_count !== undefined) {
      const retainCount = parseInt(body.backup_retain_count, 10);
      if (Number.isFinite(retainCount) && retainCount >= 1) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_retain_count', ?)"
        ).bind(retainCount.toString()).run();
      }
    }

    if (body.backup_failed_retain_count !== undefined) {
      const failedRetainCount = parseInt(body.backup_failed_retain_count, 10);
      if (Number.isFinite(failedRetainCount) && failedRetainCount >= 0) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_failed_retain_count', ?)"
        ).bind(failedRetainCount.toString()).run();
      }
    }
    
    return Response.json({ success: true, errorCode: "errSettingsSaved" });
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
    "SELECT file_name FROM backups WHERE file_name = ? AND status IN ('done','success') LIMIT 1"
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
    return Response.json({ success: false, errorCode: "errUnauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const fileName = url.searchParams.get("file");
  if (!fileName) return Response.json({ success: false, errorCode: "errMissingFileParam" }, { status: 400 });
  if (!isValidBackupFileName(fileName)) return Response.json({ success: false, errorCode: "errInvalidFileName" }, { status: 400 });
  if (!env.DB) return Response.json({ success: false, errorCode: "errDbNotConfigured" }, { status: 500 });

  const row = await env.DB.prepare(
    "SELECT id, status FROM backups WHERE file_name = ? LIMIT 1"
  ).bind(fileName).first();
  if (!row) return Response.json({ success: false, errorCode: "errRecordNotFound" }, { status: 404 });

  try {
    if (row.status === 'done' || row.status === 'success') {
      await env.BUCKET.delete(fileName);
    }
    await env.DB.prepare("DELETE FROM backups WHERE file_name = ?").bind(fileName).run();
    return Response.json({ success: true, errorCode: "errDeleteSuccess" });
  } catch (e) {
    console.error("Delete backup error:", e);
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

export default index_default;
