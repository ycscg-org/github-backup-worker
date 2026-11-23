// i18n dictionary for GitHub Backup Worker
// 独立双语字典文件，方便后续添加新语言（如日语、法语等）
// 新增语言只需在 dict 中添加新的语言键，然后在 UI 中添加对应切换按钮即可

const dict = {
  zh: {
    // 登录页
    loginTitle: 'GitHub 备份管理',
    passwordPlaceholder: '管理员密码',
    loginBtn: '登录',
    wrongPassword: '密码错误',
    
    // 通用
    loading: '加载中...',
    unknown: '未知',
    success: '成功',
    failed: '失败',
    unknownStatus: '未知',
    download: '下载',
    delete: '删除',
    deleting: '删除中...',
    save: '保存设置',
    saving: '保存中...',
    confirm: '确认',
    cancel: '取消',
    
    // 头部与按钮
    refreshLogs: '刷新日志',
    logout: '退出',
    startBackup: '开始备份',
    startFullBackup: '开始全量备份',
    resumeBackup: '恢复备份',
    
    // 警告横幅
    pauseWarning: '⚠️ R2空间不足，备份无法保存，已暂停所有自动及手动备份功能。请点击下方表格中的"删除"清理一些旧备份，腾出空间后点击右侧按钮恢复。',
    confirmResume: '确认要恢复备份功能吗？请确保您已经调大了最大可用空间或清理了历史记录。',
    resumeSuccess: '已解除熔断，请刷新页面。',
    resumeFailed: '恢复失败：',
    
    // 手动备份区
    manualBackupTitle: '手动备份单库：',
    manualRepoPlaceholder: 'owner/repo (如 ycscg-org/github-backup-worker)',
    manualBranchPlaceholder: '分支 (留空自动识别 main/master)',
    verifyingRepo: '校验仓库...',
    backingUp: '备份中',
    backupTimeout: '备份超时，已等待3分钟，请稍后刷新日志查看结果',
    backupSuccess: '备份成功！\n仓库：{repo}\n分支：{branch}\n文件大小：{size}',
    backupFailed: '备份失败：',
    inputValidRepo: '请输入正确的仓库格式，例如：ycscg-org/github-backup-worker',
    submitFailed: '提交失败：',
    requestFailed: '请求失败：',
    
    // 全量备份区
    fullBackupTitle: '全量备份组织：',
    orgPlaceholder: '组织名 (如 ycscg-org)',
    maxPerRun: '单次最多备份：',
    unit: '个',
    fullBackupHint: '提示：程序会自动跳过已成功备份最新代码的仓库。如果遇到超大仓库导致超时，可把数量改为 1 并单独尝试。',
    inputOrgName: '请输入 GitHub 组织名称',
    confirmFullBackup: '确定要触发组织 "{org}" 的全量备份吗？将自动补齐未备份的仓库（本次最多处理 {limit} 个）。',
    runningInBackground: '后台执行中 (请稍候)...',
    fullBackupTimeout: '后台任务超时，可能因仓库过大导致 Worker 执行超时被中断。请稍后刷新日志查看。',
    fullBackupComplete: '备份完成！\n成功：{success} 个\n失败：{failed} 个\n跳过：{skipped} 个',
    fullBackupFailed: '备份任务失败：',
    
    // 系统设置区
    settingsTitle: '系统设置：',
    r2MaxSpace: 'R2 最大可用空间：',
    gbUnit: 'GB',
    retainCount: '每个仓库/分支最多保留备份：',
    backupsUnit: '个',
    failedRetainCount: '失败记录最多保留：',
    recordsUnit: '条',
    settingsHint: '提示：1. 请根据你的CF计划类型合理设置最大使用R2空间限制；2. 调低成功备份保留数量会自动删除超出数量的旧备份（不可恢复）；3. 失败记录设为0将删除所有历史失败记录，相当于一键清空失败日志。',
    inputValidR2: '请输入有效的R2最大空间数值',
    inputValidRetain: '请输入有效的成功备份保留数量（≥1）',
    inputValidFailedRetain: '请输入有效的失败记录保留数量（≥0，0表示不保留任何失败记录）',
    countCleanupFailed: '统计待删除备份失败',
    submitCleanupFailed: '提交清理任务失败',
    cleaningUp: '清理中...',
    cleanupTaskSubmitted: '清理任务已提交，正在后台执行',
    cleanupTimeout: '清理任务超时，已等待3分钟，请稍后刷新日志查看结果',
    settingsSavedNoCleanup: '设置已更新，无需清理旧备份',
    saveFailed: '保存失败：',
    operationFailed: '操作失败：',
    settingsSaved: '设置已保存：',
    cleanupFailed: '清理失败：',
    
    // 清理确认弹窗
    cleanupConfirmTitle: '此操作将删除：\n',
    cleanupSuccessItem: '- {count} 个超出保留数量的成功备份（含R2文件）\n',
    cleanupFailedAllItem: '- {count} 条历史失败记录（清空所有失败日志）\n',
    cleanupFailedItem: '- {count} 条超出保留数量的失败记录\n',
    cleanupConfirmEnd: '合计 {count} 条记录，删除后不可恢复，是否继续？',
    
    // 筛选与标题
    filterRepo: '筛选仓库：',
    allRepos: '全部仓库',
    pageTitle: 'GitHub 备份管理',
    
    // 表格表头
    tableTime: '时间',
    tableRepo: '仓库',
    tableBranch: '分支',
    tableFileName: '文件名',
    tableSize: '大小',
    tableStatus: '状态',
    tableError: '信息',
    tableAction: '操作',
    noRecords: '暂无备份记录',
    loadLogsFailed: '加载日志失败',
    loadSettingsFailed: '加载设置失败',
    
    // 删除确认
    confirmDelete: '确定要删除记录「{name}」吗？此操作不可恢复！',
    deleteSuccess: '删除成功',
    deleteFailed: '删除失败：',
    unknownError: '未知错误',
    
    // 后端错误信息（错误码映射）
    errUnauthorized: '未授权访问',
    errKvNotBound: 'KV 未绑定',
    errKvNotBoundCleanup: 'KV 未绑定，无法查询清理进度',
    errRepoFormat: '仓库格式错误，请填写 owner/repo',
    errRepoNotFound: '仓库 "{repo}" 不存在，请检查拼写',
    errGithubApi: 'GitHub API 错误: {status}',
    errInputOrgName: '请填写组织名称',
    errOrgNotFound: '组织 "{org}" 不存在，请检查拼写',
    errManualBackupFailed: '手动备份失败',
    errBackupPaused: '可用空间不足，已暂停所有备份功能。请手动清理历史备份并在管理面板点击恢复。',
    errCleanupCountFailed: '统计待清理备份失败',
    errSubmitCleanupFailed: '提交清理任务失败',
    errValidRetain: '成功备份保留数量必须是大于等于1的正整数',
    errValidFailedRetain: '失败记录保留数量必须是大于等于0的整数',
    errBatchCleanupFailed: '批量清理备份失败',
    errCleanupFailedMsg: '清理失败：{msg}，已成功删除 {count} 条记录',
    errCleanupComplete: '清理完成：成功删除 {total} 条记录',
    errCleanupDetails: '（{details}）',
    errCleanupFailedItems: '，{count} 条删除失败',
    errMissingPassword: '缺少密码',
    errPasswordWrong: '密码错误',
    errSettingsSaved: '设置已保存',
    errMissingFileParam: '缺少文件参数',
    errInvalidFileName: '非法文件名',
    errBackupNotFound: '备份记录不存在',
    errBackupFileMissing: '备份文件不存在，可能已被删除',
    errDownloadFailed: '下载失败: {msg}',
    errRecordNotFound: '记录不存在',
    errDeleteSuccess: '删除成功',
    errCleanupOldBackupLog: '[清理旧备份] 删除失败: {file}',
    errCleanupOldFailedLog: '[清理失败记录] 删除失败，id: {id}',
    errSpaceFull: '所有仓库均已只剩最新备份，空间依然不足。系统已自动暂停备份，请在管理面板清理并解除暂停。',
    errWritePauseFailed: '写入熔断状态失败',
    errLogToDbFailed: 'Failed to log to D1:',
    errSyncTerminated: '备份已被熔断，任务终止',
    errSyncAborted: '备份中途因 R2 存储空间不足被熔断',
    errSyncAbortedMsg: '备份中途因 R2 存储空间不足被熔断。已成功备份 {success} 个，失败 {failed} 个，请清理空间后重试。',
    errSyncFailedMsg: '，已成功备份 {success} 个，失败 {failed} 个',
    errFetchReposFailed: '获取组织仓库列表失败: {status} {text}',
    err404: 'GitHub API Error: 404 Not Found',
    errBackupSuccessMsg: '备份成功',
  },
  
  en: {
    // Login page
    loginTitle: 'GitHub Backup Management',
    passwordPlaceholder: 'Admin Password',
    loginBtn: 'Login',
    wrongPassword: 'Incorrect password',
    
    // Common
    loading: 'Loading...',
    unknown: 'Unknown',
    success: 'Success',
    failed: 'Failed',
    unknownStatus: 'Unknown',
    download: 'Download',
    delete: 'Delete',
    deleting: 'Deleting...',
    save: 'Save Settings',
    saving: 'Saving...',
    confirm: 'Confirm',
    cancel: 'Cancel',
    
    // Header & Buttons
    refreshLogs: 'Refresh Logs',
    logout: 'Logout',
    startBackup: 'Start Backup',
    startFullBackup: 'Start Full Backup',
    resumeBackup: 'Resume Backups',
    
    // Pause warning banner
    pauseWarning: '⚠️ R2 storage is full, backups cannot be saved. All automatic and manual backups have been paused. Please delete old backups using the "Delete" button in the table below, then click the button on the right to resume.',
    confirmResume: 'Are you sure you want to resume backups? Please make sure you have increased the storage limit or cleaned up old backups.',
    resumeSuccess: 'Circuit breaker lifted. Please refresh the page.',
    resumeFailed: 'Resume failed: ',
    
    // Manual backup section
    manualBackupTitle: 'Manual Backup:',
    manualRepoPlaceholder: 'owner/repo (e.g. ycscg-org/github-backup-worker)',
    manualBranchPlaceholder: 'Branch (leave empty to auto-detect main/master)',
    verifyingRepo: 'Verifying repository...',
    backingUp: 'Backing up',
    backupTimeout: 'Backup timed out after 3 minutes. Please refresh logs later to check results.',
    backupSuccess: 'Backup successful!\nRepository: {repo}\nBranch: {branch}\nFile size: {size}',
    backupFailed: 'Backup failed: ',
    inputValidRepo: 'Please enter a valid repository in owner/repo format, e.g.: ycscg-org/github-backup-worker',
    submitFailed: 'Submit failed: ',
    requestFailed: 'Request failed: ',
    
    // Full backup section
    fullBackupTitle: 'Organization Full Backup:',
    orgPlaceholder: 'Organization name (e.g. ycscg-org)',
    maxPerRun: 'Max backups per run:',
    unit: '',
    fullBackupHint: 'Note: Repositories with the latest code already backed up will be automatically skipped. If you encounter timeout for very large repositories, set the count to 1 and try individually.',
    inputOrgName: 'Please enter GitHub organization name',
    confirmFullBackup: 'Are you sure you want to trigger a full backup for "{org}"? Up to {limit} unbacked repositories will be processed in this run.',
    runningInBackground: 'Running in background (please wait)...',
    fullBackupTimeout: 'Background task timed out, possibly interrupted by Worker execution limit due to large repositories. Please refresh logs later to check results.',
    fullBackupComplete: 'Backup complete!\nSuccess: {success}\nFailed: {failed}\nSkipped: {skipped}',
    fullBackupFailed: 'Backup task failed: ',
    
    // Settings section
    settingsTitle: 'System Settings:',
    r2MaxSpace: 'Max R2 Storage:',
    gbUnit: 'GB',
    retainCount: 'Max backups per repo/branch:',
    backupsUnit: '',
    failedRetainCount: 'Max failed records to keep:',
    recordsUnit: '',
    settingsHint: 'Note: 1. Set R2 storage limit according to your Cloudflare plan; 2. Lowering successful backup retention will automatically delete old backups beyond the new limit (irreversible); 3. Setting failed records to 0 will delete all historical failed logs, equivalent to clearing all failure logs.',
    inputValidR2: 'Please enter a valid R2 max storage value',
    inputValidRetain: 'Please enter a valid successful backup retention count (≥1)',
    inputValidFailedRetain: 'Please enter a valid failed record retention count (≥0, 0 means keep no failed records)',
    countCleanupFailed: 'Failed to count backups to delete',
    submitCleanupFailed: 'Failed to submit cleanup task',
    cleaningUp: 'Cleaning up...',
    cleanupTaskSubmitted: 'Cleanup task submitted, running in background',
    cleanupTimeout: 'Cleanup task timed out after 3 minutes. Please refresh logs later to check results.',
    settingsSavedNoCleanup: 'Settings updated, no old backups need to be cleaned up',
    saveFailed: 'Save failed: ',
    operationFailed: 'Operation failed: ',
    settingsSaved: 'Settings saved: ',
    cleanupFailed: 'Cleanup failed: ',
    
    // Cleanup confirmation dialog
    cleanupConfirmTitle: 'This operation will delete:\n',
    cleanupSuccessItem: '- {count} successful backups beyond retention limit (including R2 files)\n',
    cleanupFailedAllItem: '- {count} historical failed records (all failure logs will be cleared)\n',
    cleanupFailedItem: '- {count} failed records beyond retention limit\n',
    cleanupConfirmEnd: 'Total {count} records will be deleted. This action cannot be undone. Continue?',
    
    // Filter & title
    filterRepo: 'Filter repository:',
    allRepos: 'All repositories',
    pageTitle: 'GitHub Backup Management',
    
    // Table headers
    tableTime: 'Time',
    tableRepo: 'Repository',
    tableBranch: 'Branch',
    tableFileName: 'Filename',
    tableSize: 'Size',
    tableStatus: 'Status',
    tableError: 'Message',
    tableAction: 'Actions',
    noRecords: 'No backup records',
    loadLogsFailed: 'Failed to load logs',
    loadSettingsFailed: 'Failed to load settings',
    
    // Delete confirmation
    confirmDelete: 'Are you sure you want to delete record "{name}"? This action cannot be undone!',
    deleteSuccess: 'Deleted successfully',
    deleteFailed: 'Delete failed: ',
    unknownError: 'Unknown error',
    
    // Backend error messages (error code mapping)
    errUnauthorized: 'Unauthorized access',
    errKvNotBound: 'KV binding not configured',
    errKvNotBoundCleanup: 'KV binding not configured, cannot query cleanup progress',
    errRepoFormat: 'Invalid repository format, please use owner/repo',
    errRepoNotFound: 'Repository "{repo}" not found, please check spelling',
    errGithubApi: 'GitHub API error: {status}',
    errInputOrgName: 'Please enter organization name',
    errOrgNotFound: 'Organization "{org}" not found, please check spelling',
    errManualBackupFailed: 'Manual backup failed',
    errBackupPaused: 'Insufficient space, all backups have been paused. Please manually clean up old backups and click Resume in the admin panel.',
    errCleanupCountFailed: 'Failed to count backups to clean up',
    errSubmitCleanupFailed: 'Failed to submit cleanup task',
    errValidRetain: 'Successful backup retention must be a positive integer ≥1',
    errValidFailedRetain: 'Failed record retention must be an integer ≥0',
    errBatchCleanupFailed: 'Batch backup cleanup failed',
    errCleanupFailedMsg: 'Cleanup failed: {msg}, successfully deleted {count} records',
    errCleanupComplete: 'Cleanup complete: successfully deleted {total} records',
    errCleanupDetails: '({details})',
    errCleanupFailedItems: ', {count} items failed to delete',
    errMissingPassword: 'Missing password',
    errPasswordWrong: 'Incorrect password',
    errSettingsSaved: 'Settings saved',
    errMissingFileParam: 'Missing file parameter',
    errInvalidFileName: 'Invalid filename',
    errBackupNotFound: 'Backup record not found',
    errBackupFileMissing: 'Backup file not found, it may have been deleted',
    errDownloadFailed: 'Download failed: {msg}',
    errRecordNotFound: 'Record not found',
    errDeleteSuccess: 'Deleted successfully',
    errCleanupOldBackupLog: '[Old backup cleanup] Failed to delete: {file}',
    errCleanupOldFailedLog: '[Failed record cleanup] Failed to delete, id: {id}',
    errSpaceFull: 'All repositories only have the latest backup left, but space is still insufficient. Backups have been automatically paused, please clean up and resume from the admin panel.',
    errWritePauseFailed: 'Failed to write circuit breaker state',
    errLogToDbFailed: 'Failed to log to D1:',
    errSyncTerminated: 'Backups paused by circuit breaker, task terminated',
    errSyncAborted: 'Backup aborted mid-way due to insufficient R2 storage space',
    errSyncAbortedMsg: 'Backup aborted mid-way due to insufficient R2 storage space. {success} succeeded, {failed} failed. Please free up space and retry.',
    errSyncFailedMsg: ', {success} succeeded, {failed} failed',
    errFetchReposFailed: 'Failed to fetch organization repository list: {status} {text}',
    err404: 'GitHub API Error: 404 Not Found',
    errBackupSuccessMsg: 'Backup successful',
  }
};

// 当前语言
let currentLang = 'zh';

// 尝试从浏览器localStorage读取语言（仅在浏览器环境下）
if (typeof localStorage !== 'undefined') {
  const saved = localStorage.getItem('backup_manager_lang');
  if (saved && dict[saved]) {
    currentLang = saved;
  }
}

/**
 * 获取翻译文本
 * @param {string} key 文本键名
 * @param {object} params 替换参数，如 {repo: 'a/b', count: 5}
 * @returns {string} 翻译后的文本
 */
function t(key, params = {}) {
  let text = (dict[currentLang] && dict[currentLang][key]) || dict.zh[key] || key;
  // 替换占位符
  Object.keys(params).forEach(k => {
    text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), params[k]);
  });
  return text;
}

/**
 * 切换语言
 * @param {string} lang 目标语言代码，如 'zh' / 'en'
 */
function setLang(lang) {
  if (!dict[lang]) return;
  currentLang = lang;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('backup_manager_lang', lang);
  }
  // 如果是浏览器环境，触发页面重渲染（如果页面定义了applyLang函数）
  if (typeof window !== 'undefined' && typeof window.applyLang === 'function') {
    window.applyLang();
  }
}

/**
 * 获取当前语言代码
 * @returns {string}
 */
function getLang() {
  return currentLang;
}

/**
 * 获取所有支持的语言列表
 * @returns {object} {code: name}
 */
function getSupportedLangs() {
  return {
    zh: '中文',
    en: 'EN'
  };
}

// 导出给Worker使用（后端错误码转义用）
export { dict, t, setLang, getLang, getSupportedLangs };
