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
    return new Response(JSON.stringify({ success: false, message: "缺少密码" }),
      { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!env.ADMIN_PASSWORD || !timingSafeEqual(body.password, env.ADMIN_PASSWORD)) {
    return new Response(JSON.stringify({ success: false, message: "密码错误" }),
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
  if (!isAuthed(request, env)) return Response.json({ status: 'error', message: "未授权访问" }, { status: 401 });
  if (!env.KV) return Response.json({ status: 'error', message: "KV 未绑定" }, { status: 500 });
  
  const result = await env.KV.get('manual_backup_result');
  if (!result) return Response.json({ status: 'pending' });
  
  await env.KV.delete('manual_backup_result');
  return Response.json(JSON.parse(result));
}

// ---------- 手动备份 ----------
async function handleTriggerBackup(request, env, ctx) {
  if (!isAuthed(request, env)) {
    return Response.json({ success: false, message: "未授权访问" }, { status: 401 });
  }
  try {
    const body = await parseJson(request);
    const repoFullName = (body.repo || "").trim();
    const branch = (body.branch || "").trim();

    if (!repoFullName || !repoFullName.includes("/")) {
      return Response.json({ success: false, message: "仓库格式错误，请填写 owner/repo" }, { status: 400 });
    }

    const [owner, repoName] = repoFullName.split("/");
    if (!owner || !repoName) {
      return Response.json({ success: false, message: "仓库格式错误，请填写 owner/repo" }, { status: 400 });
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
      return Response.json({ success: false, message: `仓库 "${owner}/${repoName}" 不存在，请检查拼写` }, { status: 404 });
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
  if (!isAuthed(request, env)) return Response.json({ status: 'error', message: "未授权访问" }, { status: 401 });
  if (!env.KV) return Response.json({ status: 'error', message: "KV 未绑定" }, { status: 500 });
  
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
    const orgName = (body.org || "").trim();
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
          message: "备份中途因 R2 存储空间不足被熔断。已成功备份 " + successCount + " 个，失败 " + failedCount + " 个，请清理空间后重试。" 
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
  if (!isAuthed(request, env)) return Response.json({ status: 'error', message: "未授权访问" }, { status: 401 });
  if (!env.KV) return Response.json({ status: 'error', message: "KV 未绑定，无法查询清理进度" }, { status: 500 });
  
  const result = await env.KV.get('cleanup_result');
  if (!result) return Response.json({ status: 'pending' });
  
  await env.KV.delete('cleanup_result');
  return Response.json(JSON.parse(result));
}

// ---------- 统计待清理备份数量 ----------
async function handleCountCleanup(request, env) {
  if (!isAuthed(request, env)) {
    return Response.json({ success: false, message: "未授权访问" }, { status: 401 });
  }
  try {
    const body = await parseJson(request);
    const newRetainCount = parseInt(body.backup_retain_count, 10);
    const newFailedRetainCount = parseInt(body.backup_failed_retain_count, 10);
    
    if (!Number.isFinite(newRetainCount) || newRetainCount < 1) {
      return Response.json({ success: false, message: "成功备份保留数量必须是大于等于1的正整数" }, { status: 400 });
    }
    if (!Number.isFinite(newFailedRetainCount) || newFailedRetainCount < 0) {
      return Response.json({ success: false, message: "失败记录保留数量必须是大于等于0的整数" }, { status: 400 });
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
    return Response.json({ success: false, message: "未授权访问" }, { status: 401 });
  }
  try {
    const body = await parseJson(request);
    const newRetainCount = parseInt(body.backup_retain_count, 10);
    const newFailedRetainCount = parseInt(body.backup_failed_retain_count, 10);
    
    if (!Number.isFinite(newRetainCount) || newRetainCount < 1) {
      return Response.json({ success: false, message: "成功备份保留数量必须是大于等于1的正整数" }, { status: 400 });
    }
    if (!Number.isFinite(newFailedRetainCount) || newFailedRetainCount < 0) {
      return Response.json({ success: false, message: "失败记录保留数量必须是大于等于0的整数" }, { status: 400 });
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
      message: "清理任务已提交，正在后台执行",
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
    return new Response(loginPageHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      status: 200
    });
  }
  return new Response(adminPageHtml(), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
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
  <\/script>
</body></html>`;
}

function adminPageHtml() {
  return `<!DOCTYPE html>
<!-- v2.14 2026-11-23: 熔断状态按需写入减少冗余KV/D1写入；失败记录默认保留10条；标题显示版本号；修复弹窗换行错误 -->
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
  .col-time{width:160px;}.col-repo{width:180px;}.col-branch{width:100px;}.col-size{width:90px;}.col-status{width:70px;}.col-action{width:130px;}
  .setting-item{margin-right: 16px;}
</style></head>
<body>
<div class="container">
  <div id="pauseWarning" style="margin-bottom: 20px; padding: 15px; background: #ffebe9; border: 1px solid #ff8182; border-radius: 6px; color: #d73a49; display: none; justify-content: space-between; align-items: center;">
    <strong>⚠️ R2空间不足，备份无法保存，已暂停所有自动及手动备份功能。请点击下方表格中的“删除”清理一些旧备份，腾出空间后点击右侧按钮恢复。</strong>
    <button onclick="resumeBackups()" style="padding: 6px 16px; background: #d73a49; color: #fff; border: none; border-radius: 4px; cursor: pointer;">恢复备份</button>
  </div>

  <div style="margin-top: 20px; padding: 12px; background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
    <strong>手动备份单库：</strong>
    <input id="manualRepo" type="text" placeholder="owner/repo (如 ycscg-org/github-backup-worker)" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 300px;" />
    <input id="manualBranch" type="text" placeholder="分支 (留空自动识别 main/master)" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 220px;" />
    <button onclick="triggerManualBackup()" style="padding: 6px 16px; background: #007bff; color: #fff; border: none; border-radius: 4px; cursor: pointer;">开始备份</button>
    <button class="refresh-btn" onclick="loadLogs()" style="margin-left:auto;">刷新日志</button>
    <button class="refresh-btn" style="background:#6c757d;" onclick="logout()">退出</button>
  </div>
  <div style="margin-top: 16px; padding: 12px; background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
    <strong>全量备份组织：</strong>
    <input id="syncOrgName" type="text" placeholder="组织名 (如 ycscg-org)" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; width: 180px;" />
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;" class="setting-item">
      单次最多备份：
      <input id="syncLimit" type="number" value="10" min="1" max="100" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 60px;" />
      个
    </label>
    <button onclick="syncOrganization()" style="padding: 6px 16px; background: #d73a49; color: #fff; border: none; border-radius: 4px; cursor: pointer;">开始全量备份</button>
    <span style="font-size: 12px; color: #666; width: 100%;">提示：程序会自动跳过已成功备份最新代码的仓库。如果遇到超大仓库导致超时，可把数量改为 1 并单独尝试。</span>
  </div>
  <div style="margin-top: 16px; padding: 12px; background: #eef2f5; border: 1px solid #cbd5e1; border-radius: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
    <strong>系统设置：</strong>
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;" class="setting-item">
      R2 最大可用空间：
      <input id="r2MaxGb" type="number" step="0.5" value="8" min="1" max="1000" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 80px;" />
      GB
    </label>
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;" class="setting-item">
      每个仓库/分支最多保留备份：
      <input id="backupRetainCount" type="number" value="5" min="1" max="100" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 60px;" />
      个
    </label>
    <label style="font-size: 14px; display:flex; align-items:center; gap:4px;" class="setting-item">
      失败记录最多保留：
      <input id="failedRetainCount" type="number" value="100" min="0" max="10000" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 70px;" />
      条
    </label>
    <button onclick="saveSettings()" style="padding: 6px 16px; background: #475569; color: #fff; border: none; border-radius: 4px; cursor: pointer;">保存设置</button>
    <span style="font-size: 12px; color: #666; width: 100%;">提示：1. 请根据你的CF计划类型合理设置最大使用R2空间限制；2. 调低成功备份保留数量会自动删除超出数量的旧备份（不可恢复）；3. 失败记录设为0将删除所有历史失败记录，相当于一键清空失败日志。</span>
  </div>
  <div style="margin-top: 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
    <div style="display: flex; align-items: center; gap: 8px;">
      <label for="repoFilter" style="font-weight: 600; color: #24292e;">筛选仓库：</label>
      <select id="repoFilter" onchange="renderTable()" style="padding: 6px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
        <option value="">全部仓库</option>
      </select>
    </div>
    <h1 style="margin: 0; font-size: 22px;">GitHub 备份管理 v2.14</h1>
  </div>
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
    const setRes = await fetch('/api/settings');
    const setData = await setRes.json();
    const isPaused = setData.settings && setData.settings.backup_paused === 'true';
    document.getElementById('pauseWarning').style.display = isPaused ? 'flex' : 'none';

    const res = await fetch('/api/logs');
    if (res.status === 401) { location.reload(); return; }
    const data = await res.json();
    allLogs = data.logs || [];

    const select = document.getElementById('repoFilter');
    const currentVal = select.value;
    const repos = [...new Set(allLogs.map(l => l.repo_name).filter(Boolean))].sort();

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
    const res = await fetch('/api/settings');
    if (res.status === 401) return;
    const data = await res.json();
    if (data.success) {
      if (data.settings.r2_max_gb) {
        document.getElementById('r2MaxGb').value = data.settings.r2_max_gb;
      }
      if (data.settings.backup_retain_count) {
        document.getElementById('backupRetainCount').value = data.settings.backup_retain_count;
      }
      if (data.settings.backup_failed_retain_count !== undefined) {
        document.getElementById('failedRetainCount').value = data.settings.backup_failed_retain_count;
      }
    }
  } catch(e) { console.error("加载设置失败", e); }
}

async function saveSettings() {
  const r2MaxGbVal = document.getElementById('r2MaxGb').value;
  const retainCountVal = document.getElementById('backupRetainCount').value;
  const failedRetainCountVal = document.getElementById('failedRetainCount').value;
  const newRetainCount = parseInt(retainCountVal, 10);
  const newFailedRetainCount = parseInt(failedRetainCountVal, 10);
  
  if (!r2MaxGbVal || parseFloat(r2MaxGbVal) < 1) return alert('请输入有效的R2最大空间数值');
  if (!Number.isFinite(newRetainCount) || newRetainCount < 1) return alert('请输入有效的成功备份保留数量（≥1）');
  if (!Number.isFinite(newFailedRetainCount) || newFailedRetainCount < 0) return alert('请输入有效的失败记录保留数量（≥0，0表示不保留任何失败记录）');
  
  const btn = document.querySelector('button[onclick="saveSettings()"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '保存中...';
  
  try {
    // 先统计如果调整保留数量需要删除多少备份
    let successDeleteCount = 0;
    let failedDeleteCount = 0;
    const countRes = await fetch('/api/backup/cleanup-count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backup_retain_count: newRetainCount,
        backup_failed_retain_count: newFailedRetainCount
      })
    });
    const countData = await countRes.json();
    if (!countData.success) {
      throw new Error(countData.message || '统计待删除备份失败');
    }
    successDeleteCount = countData.successDeleteCount;
    failedDeleteCount = countData.failedDeleteCount;
    const totalDeleteCount = countData.deleteCount;

    // 如果有需要删除的备份，弹窗确认
    if (totalDeleteCount > 0) {
      let confirmMsg = '此操作将删除：\\n';
      if (successDeleteCount > 0) confirmMsg += "- " + successDeleteCount + " 个超出保留数量的成功备份（含R2文件）\\n";
      if (failedDeleteCount > 0) {
        if (newFailedRetainCount === 0) {
          confirmMsg += "- " + failedDeleteCount + " 条历史失败记录（清空所有失败日志）\\n";
        } else {
          confirmMsg += "- " + failedDeleteCount + " 条超出保留数量的失败记录\\n";
        }
      }
      confirmMsg += '合计 ' + totalDeleteCount + ' 条记录，删除后不可恢复，是否继续？';
      if (!confirm(confirmMsg)) {
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }

      // 提交清理任务
      const cleanupRes = await fetch('/api/backup/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backup_retain_count: newRetainCount,
          backup_failed_retain_count: newFailedRetainCount
        })
      });
      const cleanupResult = await cleanupRes.json();
      if (!cleanupResult.success) {
        throw new Error(cleanupResult.message || '提交清理任务失败');
      }

      btn.textContent = '清理中...';
      // 轮询清理结果
      pollCleanupStatus(btn, originalText, parseFloat(r2MaxGbVal));
      return;
    }

    // 没有需要删除的备份，直接保存设置
    const saveRes = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        r2_max_gb: parseFloat(r2MaxGbVal),
        backup_retain_count: newRetainCount,
        backup_failed_retain_count: newFailedRetainCount
      })
    });
    const saveResult = await saveRes.json();
    if (saveResult.success) {
      alert('设置已更新，无需清理旧备份');
      loadLogs();
    } else {
      alert('保存失败：' + saveResult.message);
    }
  } catch(e) {
    alert('操作失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function pollCleanupStatus(btn, originalText, r2MaxGb) {
  let attempts = 0;
  const poll = async () => {
    try {
      attempts++;
      if (attempts > 60) {
        alert('清理任务超时，已等待3分钟，请稍后刷新日志查看结果');
        btn.disabled = false;
        btn.textContent = originalText;
        loadLogs();
        return;
      }
      const res = await fetch('/api/backup/cleanup-status');
      const data = await res.json();
      if (data.status === 'pending') {
        btn.textContent = '清理中... (' + (attempts * 3) + 's)';
        setTimeout(poll, 3000);
      } else if (data.status === 'done') {
        // 清理成功后保存所有设置
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            r2_max_gb: r2MaxGb,
            backup_failed_retain_count: parseInt(document.getElementById('failedRetainCount').value, 10)
          })
        });
        alert('设置已保存：' + data.message);
        btn.disabled = false;
        btn.textContent = originalText;
        loadLogs();
      } else if (data.status === 'error') {
        alert('清理失败：' + data.message);
        btn.disabled = false;
        btn.textContent = originalText;
        loadLogs();
      }
    } catch (e) {
      console.error('轮询清理状态失败', e);
      setTimeout(poll, 3000);
    }
  };
  poll();
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
  const branch = document.getElementById('manualBranch').value.trim();
  
  if (!repo || !repo.includes('/')) {
    alert('请输入正确的仓库格式，例如：ycscg-org/github-backup-worker');
    return;
  }

  const btn = document.querySelector('button[onclick="triggerManualBackup()"]');
  btn.disabled = true;
  btn.textContent = '校验仓库...';

  try {
    const res = await fetch('/api/backup/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, branch })
    });
    const result = await res.json();
    if (result.success) {
      btn.textContent = '备份中 (' + result.branch + ')...';
      pollManualStatus(btn);
    } else {
      alert('提交失败：' + result.message);
      btn.disabled = false;
      btn.textContent = '开始备份';
    }
  } catch (e) {
    alert('请求失败：' + e.message);
    btn.disabled = false;
    btn.textContent = '开始备份';
  }
}

async function pollManualStatus(btn) {
  let attempts = 0;
  const poll = async () => {
    try {
      attempts++;
      if (attempts > 60) {
        alert('备份超时，已等待3分钟，请稍后刷新日志查看结果');
        btn.disabled = false;
        btn.textContent = '开始备份';
        loadLogs();
        return;
      }
      const res = await fetch('/api/backup/trigger-status');
      const data = await res.json();
      if (data.status === 'pending') {
        setTimeout(poll, 3000);
      } else if (data.status === 'done') {
        alert('备份成功！\\n仓库：' + data.repo + '\\n分支：' + data.branch + '\\n文件大小：' + formatSize(data.fileSize));
        document.getElementById('manualRepo').value = '';
        document.getElementById('manualBranch').value = '';
        btn.disabled = false;
        btn.textContent = '开始备份';
        loadLogs();
      } else if (data.status === 'error') {
        alert('备份失败：' + data.message);
        btn.disabled = false;
        btn.textContent = '开始备份';
        loadLogs();
      }
    } catch (e) {
      console.error('轮询备份状态失败', e);
      setTimeout(poll, 3000);
    }
  };
  setTimeout(poll, 2000);
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
  isPolling = false;

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
      loadLogs();
    }
  } catch (e) {
    alert('请求失败：' + e.message);
    btn.disabled = false;
    btn.textContent = originalText;
    loadLogs();
  }
}

async function pollSyncStatus(btn, originalText) {
  try {
    const res = await fetch('/api/backup/sync-status');
    const data = await res.json();

    if (data.status === 'pending') {
      const attempts = parseInt(btn.getAttribute('data-poll-attempts') || '0', 10);
      if (attempts >= 60) {
        isPolling = false;
        btn.disabled = false;
        btn.textContent = originalText;
        alert('后台任务超时，可能因仓库过大导致 Worker 执行超时被中断。请稍后刷新日志查看。');
        loadLogs();
        return;
      }
      btn.setAttribute('data-poll-attempts', attempts + 1);
      setTimeout(() => pollSyncStatus(btn, originalText), 3000);
    } else if (data.status === 'done') {
      isPolling = false;
      btn.disabled = false;
      btn.textContent = originalText;
      alert('备份完成！\\n成功：' + data.successCount + ' 个\\n失败：' + data.failedCount + ' 个\\n跳过：' + data.skipped + ' 个');
      loadLogs();
    } else if (data.status === 'error') {
      isPolling = false;
      btn.disabled = false;
      btn.textContent = originalText;
      alert('备份任务失败：' + data.message);
      loadLogs();
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
    // 兼容新旧两种状态值：旧版是success/failed，新版是done/error
    const isSuccess = log.status === 'done' || log.status === 'success';
    const canOperate = isSuccess && log.file_name;
    const statusText = isSuccess ? '成功' : (log.status === 'error' || log.status === 'failed') ? '失败' : '未知';
    const cells = [
      log.created_at ? new Date(log.created_at).toLocaleString('zh-CN') : '-',
      log.repo_name || '-',
      log.branch || '-',
      log.file_name || '-',
      formatSize(log.file_size),
      statusText,
      log.error_msg || '-'
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
    if (row.status === 'done' || row.status === 'success') {
      await env.BUCKET.delete(fileName);
    }
    await env.DB.prepare("DELETE FROM backups WHERE file_name = ?").bind(fileName).run();
    return Response.json({ success: true, message: "删除成功" });
  } catch (e) {
    console.error("Delete backup error:", e);
    return Response.json({ success: false, message: e.message }, { status: 500 });
  }
}

export default index_default;