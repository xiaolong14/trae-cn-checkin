#!/usr/bin/env node
'use strict';

/**
 * Trae CN 每日签到脚本
 *
 * 流程：定位登录态 -> 解密 accessToken -> 查询签到状态 -> 未签到则领取积分 -> 写入 SQLite 记录。
 * 失败策略：整体失败（退出码 1）时按配置重试，默认重试 2 次、间隔 10 分钟；
 *           登录失效（2）、未开通（3）、成功（0）不重试。
 * 安全：令牌仅在内存中使用，不打印、不写日志。
 *
 * 常用参数：
 *   --json                         输出 JSON 结果
 *   --history                      查看历史记录与统计
 *   --limit=20                     配合 --history 指定条数
 *   --selftest                     安装前自检（解密登录态 + 查询状态，不领取）
 *   --trigger=manual               记录本次触发来源（manual / auto）
 *   --retries=2                    失败后的重试次数，默认 2
 *   --retry-delay-seconds=600      每次重试间隔秒数，默认 600
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ===== 协议常量区：官方更新后优先检查这里 =====
const API_BASE = (process.env.TRAE_CHECKIN_ENDPOINT || 'https://api.trae.cn').replace(/\/+$/, '');
const STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';
const REQ_SOURCE_IDE = 1;
const MAGIC = [0x74, 0x63, 0x05, 0x10, 0x00, 0x00];
const MASK_A = Buffer.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const MASK_B = Buffer.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);
// ===== 协议常量区结束 =====

const REQUEST_TIMEOUT_MS = 20000;
const STATUS_RETRIES = 2;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_SECONDS = 600;
const MAX_RETRIES = 10;
const MAX_RETRY_DELAY_SECONDS = 3600;
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_AUTH = 2;
const EXIT_DISABLED = 3;

const ARGS = parseArgs(process.argv.slice(2));
const OUTPUT_JSON = ARGS.json;

/** 把配置值收敛到合法整数范围，非法时回退默认值 */
function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** 解析命令行参数；重试配置支持环境变量作为默认值 */
function parseArgs(argv) {
  const args = {
    json: false,
    mode: 'checkin',
    trigger: 'manual',
    limit: 20,
    retries: clampInteger(process.env.TRAE_CHECKIN_RETRIES, DEFAULT_RETRIES, 0, MAX_RETRIES),
    retryDelaySeconds: clampInteger(
      process.env.TRAE_CHECKIN_RETRY_DELAY_SECONDS,
      DEFAULT_RETRY_DELAY_SECONDS,
      0,
      MAX_RETRY_DELAY_SECONDS
    ),
  };
  for (const item of argv) {
    if (item === '--json') args.json = true;
    else if (item === '--history') args.mode = 'history';
    else if (item === '--selftest') args.mode = 'selftest';
    else if (item === '--help' || item === '-h') args.mode = 'help';
    else if (item.startsWith('--trigger=')) args.trigger = item.slice(10) || 'manual';
    else if (item.startsWith('--limit=')) args.limit = clampInteger(item.slice(8), 20, 1, 1000);
    else if (item.startsWith('--retries=')) {
      args.retries = clampInteger(item.slice(10), DEFAULT_RETRIES, 0, MAX_RETRIES);
    } else if (item.startsWith('--retry-delay-seconds=')) {
      args.retryDelaySeconds = clampInteger(item.slice(22), DEFAULT_RETRY_DELAY_SECONDS, 0, MAX_RETRY_DELAY_SECONDS);
    }
  }
  return args;
}

/** 计算 SHA-512 摘要 */
function sha512(buffer) {
  return crypto.createHash('sha512').update(buffer).digest();
}

/** 计算派生密钥使用的固定异或掩码 */
function buildXorMask() {
  const mask = Buffer.alloc(64);
  for (let i = 0; i < 64; i += 1) {
    mask[i] = MASK_A[i] ^ MASK_B[i];
  }
  return mask;
}

const XOR_MASK = buildXorMask();

/** 按客户端 Che() 逻辑派生 AES-128 密钥与 IV */
function deriveAesKey(salt) {
  const seed = Buffer.alloc(128);
  sha512(salt).copy(seed, 0);
  XOR_MASK.copy(seed, 64);
  const digest = sha512(seed);
  return { key: digest.subarray(0, 16), iv: digest.subarray(16, 32) };
}

/** 解密 tc 格式的登录态字符串，返回明文 JSON 文本 */
function decryptAuthValue(encoded) {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length < 38) {
    throw new Error('登录态内容长度异常');
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (raw[i] !== MAGIC[i]) {
      throw new Error('登录态格式不匹配（魔数错误）');
    }
  }
  const salt = raw.subarray(6, 38);
  const ciphertext = raw.subarray(38);
  const { key, iv } = deriveAesKey(salt);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plain.length <= 64) {
    throw new Error('登录态内容不完整');
  }
  const checksum = plain.subarray(0, 64);
  const body = plain.subarray(64);
  if (!sha512(body).equals(checksum)) {
    throw new Error('登录态校验失败');
  }
  return body.toString('utf8');
}

/** 生成候选的用户数据目录列表 */
function listUserDataDirs() {
  const dirs = [];
  if (process.env.TRAE_USER_DATA_DIR) {
    dirs.push(...process.env.TRAE_USER_DATA_DIR.split(path.delimiter).filter(Boolean));
  }
  let appData = process.env.APPDATA;
  if (!appData) {
    appData = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config');
  }
  for (const name of ['Trae CN', 'TRAE SOLO CN', 'Trae', 'TRAE SOLO']) {
    dirs.push(path.join(appData, name));
  }
  try {
    for (const name of fs.readdirSync(appData)) {
      if (/^trae/i.test(name)) {
        dirs.push(path.join(appData, name));
      }
    }
  } catch {
    // APPDATA 不可读时忽略，后续统一报错
  }
  return [...new Set(dirs)];
}

/** 找到第一个包含登录态文件的用户数据目录 */
function resolveUserDataDir() {
  for (const dir of listUserDataDirs()) {
    if (fs.existsSync(path.join(dir, 'User', 'globalStorage', 'storage.json'))) {
      return dir;
    }
  }
  throw new Error('未找到 Trae 登录态文件，请通过 TRAE_USER_DATA_DIR 指定用户数据目录');
}

/** 从 storage.json 中读取并解析登录态（含 accessToken） */
function readAuthInfo(userDataDir) {
  const storagePath = path.join(userDataDir, 'User', 'globalStorage', 'storage.json');
  const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const keys = Object.keys(storage).filter((key) => key.startsWith('iCubeAuthInfo://'));
  for (const key of keys) {
    try {
      const value = typeof storage[key] === 'string' ? storage[key] : '';
      if (!value) continue;
      const info = JSON.parse(decryptAuthValue(value));
      if (info && typeof info.token === 'string' && info.userId) {
        // 签到领取接口要求携带客户端设备标识，缺失会返回 9004
        const deviceId =
          typeof storage['telemetry.devDeviceId'] === 'string' ? storage['telemetry.devDeviceId'] : '';
        return { info, storagePath, deviceId };
      }
    } catch {
      // 单个键解密失败时继续尝试其他键
    }
  }
  throw new Error('登录态解密失败，请打开 Trae CN 确认已登录');
}

/** 返回本地日期 YYYY-MM-DD */
function localDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 返回本地日期时间 HH:mm:ss */
function localTimeText(isoText) {
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 延时等待 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 加载内置 SQLite；旧版 Node 自动带 --experimental-sqlite 重启自身 */
function loadSqliteModule() {
  try {
    return require('node:sqlite');
  } catch {
    const parts = process.versions.node.split('.').map((value) => Number(value));
    const major = parts[0] || 0;
    const minor = parts[1] || 0;
    if (major < 22 || (major === 22 && minor < 5)) {
      throw new Error(`当前 Node.js ${process.versions.node} 不支持内置 SQLite，请升级到 22.5 及以上`);
    }
    if (process.env.TRAE_CHECKIN_SQLITE_REEXEC === '1') {
      throw new Error('当前 Node.js 不支持内置 SQLite，请升级到 Node.js 22.5 及以上');
    }
    const { spawnSync } = require('child_process');
    const child = spawnSync(
      process.execPath,
      ['--experimental-sqlite', __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, TRAE_CHECKIN_SQLITE_REEXEC: '1' } }
    );
    process.exit(typeof child.status === 'number' ? child.status : EXIT_FAIL);
  }
}

/** 返回 SQLite 数据库路径 */
function resolveDbPath() {
  if (process.env.TRAE_CHECKIN_DB) {
    return process.env.TRAE_CHECKIN_DB;
  }
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'trae-cn-checkin', 'checkin.db');
}

/** 旧库补列：仅当列不存在时执行 ALTER TABLE，保证升级不丢历史数据 */
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** 打开数据库并初始化表结构（含旧库迁移） */
function createLedger(dbPath) {
  const { DatabaseSync } = loadSqliteModule();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkin_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL,
      local_date TEXT NOT NULL,
      trigger TEXT NOT NULL,
      stage TEXT NOT NULL,
      result TEXT NOT NULL,
      http_status INTEGER,
      business_code INTEGER,
      credits INTEGER,
      extra_credits INTEGER,
      did_checked_in INTEGER,
      user_id TEXT,
      message TEXT,
      error TEXT,
      duration_ms INTEGER,
      attempt INTEGER,
      max_attempts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_checkin_runs_date ON checkin_runs(local_date);
    CREATE TABLE IF NOT EXISTS daily_claims (
      claim_date TEXT PRIMARY KEY,
      claimed_at TEXT NOT NULL,
      source TEXT NOT NULL,
      balance INTEGER,
      user_id TEXT
    );
  `);
  ensureColumn(db, 'checkin_runs', 'attempt', 'INTEGER');
  ensureColumn(db, 'checkin_runs', 'max_attempts', 'INTEGER');
  const insertRun = db.prepare(`
    INSERT INTO checkin_runs
      (run_at, local_date, trigger, stage, result, http_status, business_code, credits,
       extra_credits, did_checked_in, user_id, message, error, duration_ms, attempt, max_attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectClaim = db.prepare('SELECT claim_date, claimed_at, source, balance, user_id FROM daily_claims WHERE claim_date = ?');
  const insertClaim = db.prepare('INSERT OR IGNORE INTO daily_claims (claim_date, claimed_at, source, balance, user_id) VALUES (?, ?, ?, ?, ?)');
  const updateClaim = db.prepare('UPDATE daily_claims SET balance = COALESCE(balance, ?), user_id = COALESCE(user_id, ?) WHERE claim_date = ?');
  const selectRecent = db.prepare('SELECT * FROM checkin_runs ORDER BY id DESC LIMIT ?');
  const monthStats = db.prepare('SELECT COUNT(*) AS days FROM daily_claims WHERE claim_date >= ?');
  const totalStats = db.prepare('SELECT COUNT(*) AS days FROM daily_claims');
  const latestBalance = db.prepare('SELECT credits FROM checkin_runs WHERE credits IS NOT NULL ORDER BY id DESC LIMIT 1');

  return {
    dbPath,
    /** 写入一条执行记录，返回记录 ID */
    recordRun(run) {
      const result = insertRun.run(
        run.runAt,
        run.localDate,
        run.trigger,
        run.stage,
        run.result,
        run.httpStatus === undefined ? null : run.httpStatus,
        run.businessCode === undefined ? null : run.businessCode,
        run.credits === undefined ? null : run.credits,
        run.extraCredits === undefined ? null : run.extraCredits,
        run.didCheckedIn === undefined ? null : (run.didCheckedIn ? 1 : 0),
        run.userId || null,
        run.message || null,
        run.error || null,
        run.durationMs === undefined ? null : run.durationMs,
        run.attempt === undefined ? null : run.attempt,
        run.maxAttempts === undefined ? null : run.maxAttempts
      );
      return Number(result.lastInsertRowid);
    },
    /** 查询某天是否已有成功领取记录 */
    hasClaimed(date) {
      return selectClaim.get(date) || null;
    },
    /** 记录某天已领取，重复日期自动忽略；balance 表示签到后的积分余额 */
    markClaimed(date, source, balance, userId) {
      insertClaim.run(date, new Date().toISOString(), source, balance === undefined ? null : balance, userId || null);
      updateClaim.run(balance === undefined ? null : balance, userId || null, date);
    },
    /** 查询最近执行记录 */
    recent(limit) {
      return selectRecent.all(limit);
    },
    /** 查询本月、累计签到天数与最近一次积分余额 */
    stats() {
      const monthStart = `${localDate().slice(0, 8)}01`;
      const month = monthStats.get(monthStart) || { days: 0 };
      const total = totalStats.get() || { days: 0 };
      const latest = latestBalance.get();
      return {
        monthDays: month.days,
        totalDays: total.days,
        latestBalance: latest && typeof latest.credits === 'number' ? latest.credits : undefined,
      };
    },
  };
}

/** 尝试打开数据库，失败时返回错误信息而不中断签到 */
function tryOpenLedger() {
  try {
    return { ledger: createLedger(resolveDbPath()), error: '' };
  } catch (error) {
    return { ledger: null, error: error.message };
  }
}

/**
 * 调用签到接口
 * @param {string} pathname 接口路径
 * @param {string} token 登录令牌
 * @param {number} retries 网络错误或 5xx 时的短重试次数（本次尝试内部）
 * @param {string} [deviceId] 客户端设备标识，缺失时接口可能返回 9004
 * @returns {Promise<{httpStatus: number, data: object}>}
 */
async function postCheckinApi(pathname, token, retries, deviceId) {
  const url = `${API_BASE}${pathname}`;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Cloud-IDE-JWT ${token}`,
      };
      if (deviceId) headers['x-device-id'] = deviceId;
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ req_source: REQ_SOURCE_IDE }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 300) };
      }
      if (response.status >= 500 && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { httpStatus: response.status, data };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  throw new Error(`签到接口网络请求失败：${lastError ? lastError.message : '未知错误'}`);
}

/** 校验状态响应并按业务结果返回 */
function parseStatus(data) {
  if (typeof data.enable !== 'boolean' || typeof data.checked_in !== 'boolean') {
    throw new Error('签到状态响应格式异常');
  }
  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`签到状态接口返回业务错误：${data.code} ${data.message || ''}`.trim());
  }
  return data;
}

/** 执行一次签到状态查询 */
async function fetchStatus(token, deviceId) {
  const response = await postCheckinApi(STATUS_PATH, token, STATUS_RETRIES, deviceId);
  if (response.httpStatus === 401 || response.httpStatus === 403) {
    const error = new Error('登录态已失效，请打开 Trae CN 重新登录');
    error.exitCode = EXIT_AUTH;
    error.httpStatus = response.httpStatus;
    throw error;
  }
  if (response.httpStatus !== 200) {
    const error = new Error(`签到状态接口返回 HTTP ${response.httpStatus}`);
    error.httpStatus = response.httpStatus;
    throw error;
  }
  return parseStatus(response.data);
}

/** 统一的文本/JSON 结果输出；多次尝试只在最后输出一次 */
function outputCheckin(outcome) {
  const { result, exitCode, ledger, dbWarning, recordId, attempts, retry } = outcome;
  if (OUTPUT_JSON) {
    const payload = {
      ok: exitCode === EXIT_OK,
      ...result,
      exitCode,
      recordId: recordId || undefined,
      dbPath: ledger ? ledger.dbPath : undefined,
      dbWarning: dbWarning || undefined,
      retry: { retries: retry.maxAttempts - 1, delaySeconds: retry.delaySeconds },
      attempts: attempts.map((item) => ({
        attempt: item.attempt,
        maxAttempts: item.maxAttempts,
        exitCode: item.exitCode,
        stage: item.stage,
        result: item.result,
        message: item.message,
        recordId: item.recordId || undefined,
        durationMs: item.durationMs,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const prefix = exitCode === EXIT_OK ? '[成功]' : '[失败]';
  console.log(`${prefix} ${result.message}`);
  if (attempts.length > 1) {
    console.log(`共尝试 ${attempts.length} 次，最终结果：${result.result}`);
  }
  if (typeof result.credits === 'number') {
    console.log(`当前积分：${result.credits}`);
  }
  if (ledger) {
    console.log(`记录：${ledger.dbPath}${recordId ? `（第 ${recordId} 条）` : ''}`);
  }
  if (dbWarning) {
    console.log(`[警告] ${dbWarning}`);
  }
}

/** 创建一条执行记录的通用函数 */
function buildRun(result, extra) {
  return {
    runAt: new Date().toISOString(),
    localDate: localDate(),
    trigger: ARGS.trigger,
    stage: result.stage,
    result: result.result,
    httpStatus: result.httpStatus,
    businessCode: result.businessCode,
    credits: result.credits,
    extraCredits: result.extraCredits,
    didCheckedIn: result.didCheckedIn,
    userId: result.userId,
    message: result.message,
    error: result.error,
    durationMs: extra ? extra.durationMs : undefined,
    attempt: extra ? extra.attempt : undefined,
    maxAttempts: extra ? extra.maxAttempts : undefined,
  };
}

/**
 * 执行一次完整签到尝试
 * @param {{attempt: number, maxAttempts: number, ledger: object|null, state: {dbWarning: string}}} context
 * @returns {Promise<{exitCode: number, result: object, recordId: number|undefined, summary: object}>}
 */
async function runCheckinAttempt({ attempt, maxAttempts, ledger, state }) {
  const startedAt = Date.now();
  const finish = (result, exitCode) => {
    let recordId;
    if (ledger) {
      try {
        recordId = ledger.recordRun(
          buildRun(result, { durationMs: Date.now() - startedAt, attempt, maxAttempts })
        );
      } catch (error) {
        state.dbWarning = `SQLite 写入失败：${error.message}`;
      }
    }
    return {
      exitCode,
      result,
      recordId,
      summary: {
        attempt,
        maxAttempts,
        exitCode,
        stage: result.stage,
        result: result.result,
        message: result.message,
        recordId,
        durationMs: Date.now() - startedAt,
      },
    };
  };

  let userDataDir = '';
  try {
    userDataDir = resolveUserDataDir();
    const { info, deviceId } = readAuthInfo(userDataDir);
    const { token, userId } = info;
    const today = localDate();

    let status;
    try {
      status = await fetchStatus(token, deviceId);
    } catch (error) {
      return finish(
        {
          stage: 'status',
          result: error.exitCode === EXIT_AUTH ? 'auth_failed' : 'failed',
          httpStatus: error.httpStatus,
          userId,
          message: error.message,
          error: error.message,
        },
        error.exitCode || EXIT_FAIL
      );
    }

    if (!status.enable) {
      return finish(
        { stage: 'status', result: 'disabled', userId, credits: status.credits, message: '当前账号未开通签到功能' },
        EXIT_DISABLED
      );
    }

    if (status.checked_in) {
      if (ledger) {
        try {
          ledger.markClaimed(today, 'server', status.credits, userId);
        } catch (error) {
          state.dbWarning = `SQLite 写入失败：${error.message}`;
        }
      }
      return finish(
        {
          stage: 'status',
          result: 'already_checked_in',
          userId,
          checkedIn: true,
          credits: status.credits,
          extraCredits: status.extra_credits,
          didCheckedIn: status.did_checked_in,
          message: '今日已签到',
        },
        EXIT_OK
      );
    }

    // 本地已有成功记录时不再重复调用领取接口
    if (ledger) {
      let localClaim = null;
      try {
        localClaim = ledger.hasClaimed(today);
      } catch (error) {
        state.dbWarning = `SQLite 读取失败：${error.message}`;
      }
      if (localClaim) {
        return finish(
          {
            stage: 'claim',
            result: 'skipped_local_record',
            userId,
            checkedIn: true,
            credits: status.credits,
            message: `本地记录显示今日已领取（${localClaim.claimed_at}），跳过重复签到`,
          },
          EXIT_OK
        );
      }
    }

    // 未签到：调用领取接口
    let claimData;
    try {
      const response = await postCheckinApi(CLAIM_PATH, token, 0, deviceId);
      if (response.httpStatus === 401 || response.httpStatus === 403) {
        return finish(
          {
            stage: 'claim',
            result: 'auth_failed',
            httpStatus: response.httpStatus,
            userId,
            message: '登录态已失效，请打开 Trae CN 重新登录',
          },
          EXIT_AUTH
        );
      }
      if (response.httpStatus !== 200) {
        return finish(
          {
            stage: 'claim',
            result: 'http_error',
            httpStatus: response.httpStatus,
            userId,
            message: `签到领取接口返回 HTTP ${response.httpStatus}`,
          },
          EXIT_FAIL
        );
      }
      claimData = response.data || {};
    } catch (error) {
      return finish(
        { stage: 'claim', result: 'failed', userId, message: error.message, error: error.message },
        EXIT_FAIL
      );
    }

    if (typeof claimData.code === 'number' && claimData.code !== 0) {
      // 9004 常见于并发领取或已签到：回查状态确认是否实际已签到
      if (claimData.code === 9004) {
        try {
          const latest = await fetchStatus(token, deviceId);
          if (latest.checked_in) {
            if (ledger) {
              try {
                ledger.markClaimed(today, 'server', latest.credits, userId);
              } catch (error) {
                state.dbWarning = `SQLite 写入失败：${error.message}`;
              }
            }
            return finish(
              {
                stage: 'claim',
                result: 'claimed_elsewhere',
                userId,
                checkedIn: true,
                credits: latest.credits,
                extraCredits: latest.extra_credits,
                message: '今日已签到（领取接口返回 9004，状态确认已领取）',
              },
              EXIT_OK
            );
          }
        } catch {
          // 回查失败时按业务失败处理
        }
      }
      return finish(
        {
          stage: 'claim',
          result: 'business_failed',
          businessCode: claimData.code,
          userId,
          message: `签到失败：${claimData.code} ${claimData.message || ''}`.trim(),
        },
        EXIT_FAIL
      );
    }

    // 领取成功后回查状态，拿到最新积分
    let credits = typeof claimData.credits === 'number' ? claimData.credits : undefined;
    let extraCredits = typeof claimData.extra_credits === 'number' ? claimData.extra_credits : undefined;
    try {
      const latest = await fetchStatus(token, deviceId);
      if (typeof latest.credits === 'number') credits = latest.credits;
      if (typeof latest.extra_credits === 'number') extraCredits = latest.extra_credits;
    } catch {
      // 回查失败不影响签到成功结论
    }
    if (ledger) {
      try {
        ledger.markClaimed(today, 'claim', credits, userId);
      } catch (error) {
        state.dbWarning = `SQLite 写入失败：${error.message}`;
      }
    }
    return finish(
      {
        stage: 'claim',
        result: 'claimed',
        userId,
        checkedIn: true,
        credits,
        extraCredits,
        message: '签到完成，积分已领取',
      },
      EXIT_OK
    );
  } catch (error) {
    return finish(
      { stage: 'init', result: 'failed', userId: '', message: error.message, error: error.message },
      EXIT_FAIL
    );
  }
}

/** 执行签到并在整体失败时按配置重试，最后统一输出一次结果 */
async function executeWithRetries() {
  const { ledger, error: openError } = tryOpenLedger();
  const state = { dbWarning: openError ? `SQLite 不可用：${openError}` : '' };
  const maxAttempts = ARGS.retries + 1;
  const retry = { maxAttempts, delaySeconds: ARGS.retryDelaySeconds };
  const attempts = [];
  let last;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await runCheckinAttempt({ attempt, maxAttempts, ledger, state });
    attempts.push(last.summary);
    if (last.exitCode !== EXIT_FAIL) break;
    if (attempt === maxAttempts) break;
    if (!OUTPUT_JSON) {
      console.log(`[重试] 第 ${attempt}/${maxAttempts} 次尝试失败：${last.result.message}`);
      console.log(`[重试] ${ARGS.retryDelaySeconds} 秒后进行第 ${attempt + 1}/${maxAttempts} 次尝试`);
    }
    await sleep(ARGS.retryDelaySeconds * 1000);
  }

  outputCheckin({
    result: last.result,
    exitCode: last.exitCode,
    recordId: last.recordId,
    ledger,
    dbWarning: state.dbWarning,
    attempts,
    retry,
  });
  return last.exitCode;
}

/** 输出历史签到记录与统计 */
function runHistory() {
  const { ledger, error } = tryOpenLedger();
  if (!ledger) {
    if (OUTPUT_JSON) {
      console.log(JSON.stringify({ ok: false, message: `SQLite 不可用：${error}` }, null, 2));
    } else {
      console.error(`[失败] SQLite 不可用：${error}`);
    }
    return EXIT_FAIL;
  }
  const rows = ledger.recent(ARGS.limit);
  const stats = ledger.stats();
  if (OUTPUT_JSON) {
    console.log(JSON.stringify({ ok: true, dbPath: ledger.dbPath, rows, stats }, null, 2));
    return EXIT_OK;
  }
  const labels = {
    already_checked_in: '已签到',
    claimed: '签到成功',
    claimed_elsewhere: '签到成功',
    skipped_local_record: '本地已签',
    disabled: '未开通',
    auth_failed: '登录失效',
    http_error: '接口异常',
    business_failed: '业务失败',
    failed: '失败',
  };
  console.log('最近签到记录：');
  if (rows.length === 0) {
    console.log('（暂无记录）');
  }
  for (const row of rows) {
    const label = labels[row.result] || row.result;
    const balance = row.credits === null ? '-' : String(row.credits);
    const attemptText =
      row.attempt && row.max_attempts ? `  尝试 ${row.attempt}/${row.max_attempts}` : '';
    console.log(
      `${row.local_date} ${localTimeText(row.run_at)}  ${String(row.trigger).padEnd(6)}  ${label.padEnd(6)}  余额 ${balance}${attemptText}`
    );
  }
  console.log('');
  console.log(`本月签到 ${stats.monthDays} 天，历史签到 ${stats.totalDays} 天`);
  if (typeof stats.latestBalance === 'number') {
    console.log(`最近积分余额：${stats.latestBalance}`);
  }
  console.log(`数据库：${ledger.dbPath}`);
  return EXIT_OK;
}

/** 安装前自检：验证登录态、SQLite 与签到接口，不领取积分 */
async function runSelftest() {
  const report = { ok: false, node: process.version, sqlite: false };
  let exitCode = EXIT_FAIL;
  try {
    const { ledger, error } = tryOpenLedger();
    if (!ledger) {
      throw new Error(`SQLite 不可用：${error}`);
    }
    report.sqlite = true;
    report.dbPath = ledger.dbPath;
    report.node = process.version;

    const userDataDir = resolveUserDataDir();
    const { info, storagePath, deviceId } = readAuthInfo(userDataDir);
    report.storagePath = storagePath;
    report.userId = info.userId;

    const status = await fetchStatus(info.token, deviceId);
    report.api = {
      httpStatus: 200,
      enable: status.enable,
      checkedIn: status.checked_in,
      credits: status.credits,
    };
    report.ok = true;
    report.message = status.checked_in ? '今日已签到' : '登录态有效，今日尚未签到';
    exitCode = EXIT_OK;
  } catch (error) {
    report.message = error.message;
    report.ok = false;
    exitCode = error.exitCode || EXIT_FAIL;
    if (error.exitCode === EXIT_AUTH) report.api = { httpStatus: error.httpStatus };
  }

  if (OUTPUT_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const prefix = report.ok ? '[自检通过]' : '[自检失败]';
    console.log(`${prefix} ${report.message}`);
    console.log(`Node.js：${report.node}`);
    console.log(`SQLite：${report.sqlite ? '正常' : '不可用'}`);
    if (report.storagePath) console.log(`登录态：${report.storagePath}`);
    if (report.dbPath) console.log(`数据库：${report.dbPath}`);
    if (report.api && typeof report.api.credits === 'number') {
      console.log(`积分：${report.api.credits}`);
    }
  }
  return exitCode;
}

/** 输出帮助信息 */
function showHelp() {
  console.log(`Trae CN 每日签到

用法：
  node checkin.js                          立即签到（已签到自动跳过）
  node checkin.js --json                   输出 JSON
  node checkin.js --history                查看历史记录与统计
  node checkin.js --limit=50               配合 --history 指定条数
  node checkin.js --selftest               安装前自检（不领取积分）
  node checkin.js --trigger=auto           记录触发来源
  node checkin.js --retries=2              失败后重试次数（默认 2，范围 0-10）
  node checkin.js --retry-delay-seconds=600 重试间隔秒数（默认 600，范围 0-3600）

环境变量：
  TRAE_USER_DATA_DIR               指定 Trae 用户数据目录
  TRAE_CHECKIN_DB                  指定 SQLite 数据库路径
  TRAE_CHECKIN_ENDPOINT            覆盖接口根地址
  TRAE_CHECKIN_RETRIES             重试次数默认值（默认 2）
  TRAE_CHECKIN_RETRY_DELAY_SECONDS 重试间隔默认值（默认 600）`);
  return EXIT_OK;
}

/** 程序入口：按参数分发到自检、历史或签到流程 */
async function main() {
  if (ARGS.mode === 'help') return showHelp();
  if (ARGS.mode === 'history') return runHistory();
  if (ARGS.mode === 'selftest') return runSelftest();
  return executeWithRetries();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[失败] ${error && error.message ? error.message : error}`);
    process.exitCode = EXIT_FAIL;
  });
