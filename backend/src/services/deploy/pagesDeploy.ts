import { Account } from '../../models/account';
import { getDeployHeaders } from './headers';
import { computeStaticAssetHash, getContentType } from '../staticAssets';
import { appLogger } from '../logger';
import { proxyFetch } from '../proxyService';
import { buildMultipartBody, type MultipartPart } from './uploadForm';

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_RETRIES = 3;
const MAX_JWT_RETRIES = 2;

// ---- JWT 工具 ----

function decodeJwtPayload(jwt: string): { exp?: number } | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
    return payload;
  } catch {
    return null;
  }
}

function isJwtExpired(jwt: string): boolean {
  const payload = decodeJwtPayload(jwt);
  if (!payload?.exp) return false; // 无 exp 字段时不判定过期
  // 提前 30 秒判定过期，避免边界竞态
  return Date.now() / 1000 > payload.exp - 30;
}

// ---- 重试工具 ----

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = MAX_RETRIES): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// ---- 特殊文件 ----

const SPECIAL_FILES = new Set([
  '_worker.js', '_worker.bundle', '_headers', '_redirects',
  '_routes.json', 'functions-filepath-routing-config.json',
]);

// wrangler 对这些文本配置文件：读为 UTF-8 字符串 → new File([string])
// _worker.bundle / _worker.js 走 FormData 包装（二进制）
const TEXT_SPECIAL_FILES = new Set([
  '_routes.json', '_headers', '_redirects', 'functions-filepath-routing-config.json',
]);

export interface DeployPageFile { path: string; buffer: Buffer; }

export interface DeployPagesOptions {
  skipCreateProject?: boolean;
  productionBranch?: string;
  branch?: string;
  commitMessage?: string;
  commitHash?: string;
  commitDirty?: boolean | string;
  deploymentConfigs?: any;
}

// ---- 部署状态轮询 ----

async function pollDeploymentStatus(
  account: Account,
  projectName: string,
  deploymentId: string,
): Promise<{ status: 'success' | 'failure'; logs?: string }> {
  const deployHeaders = getDeployHeaders(account);
  let delay = 2000;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, delay));
    const resp = await proxyFetch(`${CF_BASE}/accounts/${account.account_id}/pages/projects/${projectName}/deployments/${deploymentId}`, {
      headers: { ...deployHeaders },
    }, 300000, undefined, account);
    if (resp.ok) {
      const json = await resp.json() as any;
      const stage = json?.result?.latest_stage;
      if (stage?.status === 'success') return { status: 'success' };
      if (stage?.status === 'failure') {
        const stages = json?.result?.stages || [];
        const failed = stages.filter((s: any) => s.status === 'failure');
        const info = failed.map((s: any) => `${s.name}: ${s.error || s.message || 'unknown'}`).join(' | ')
          || `${stage.name || 'deploy'} (no error message)`;
        return { status: 'failure', logs: info };
      }
    }
    delay = Math.min(delay * 1.5, 10000);
  }
  return { status: 'failure', logs: 'Polling timeout' };
}

// ---- 确保项目存在 ----

async function ensurePagesProject(account: Account, name: string): Promise<void> {
  const deployHeaders = getDeployHeaders(account);
  try {
    await proxyFetch(`${CF_BASE}/accounts/${account.account_id}/pages/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deployHeaders },
      body: JSON.stringify({ name, production_branch: 'main' }),
    }, 30000, undefined, account);
  } catch (e: any) {
    if (!e.body?.includes('already exists') && e.status !== 409) throw e;
  }
}

// ---- 主部署函数 ----

export async function deployPages(
  account: Account,
  name: string,
  files: DeployPageFile[],
  opts: DeployPagesOptions = {},
): Promise<any> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const deployHeaders = getDeployHeaders(account);

  // Step 0: 确保项目存在
  if (!opts.skipCreateProject) {
    await ensurePagesProject(account, name);
  }

  // 如果包含 Functions bundle（_worker.bundle / _worker.js）且调用方没传 deploymentConfigs，
  // 自动补上 compatibility_date，否则 CF build 阶段直接 failure 且无具体错误信息
  if (!opts.deploymentConfigs && files && files.some(f => {
    const p = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    return p === '_worker.bundle' || p === '_worker.js';
  })) {
    appLogger.info(`[Pages Deploy] Auto-detected Functions bundle, setting compatibility_date`);
    opts.deploymentConfigs = {
      production: { compatibility_date: '2024-11-01' },
      preview: { compatibility_date: '2024-11-01' },
    };
  }

  // Step 0.5: 设置 deployment_configs（bindings + env）— 修复双端不对称
  if (opts.deploymentConfigs) {
    appLogger.info(`[Pages Deploy] PATCH deployment_configs: ${JSON.stringify(opts.deploymentConfigs).slice(0, 500)}`);
    try {
      const patchResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
        body: JSON.stringify({ deployment_configs: opts.deploymentConfigs }),
      }, 30000, undefined, account);
      if (!patchResp.ok) {
        const errText = await patchResp.text().catch(() => '');
        appLogger.error(`[Pages Deploy] PATCH deployment_configs FAILED: ${patchResp.status} ${errText.slice(0, 1000)}`);
      } else {
        appLogger.info(`[Pages Deploy] PATCH deployment_configs OK`);
      }
    } catch (e: any) {
      appLogger.warn(`[Pages Deploy] Failed to set deployment_configs: ${e.message}`);
    }
  }

  // 空文件时返回 project 对象
  if (!files || files.length === 0) {
    const resp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}`, {
      headers: { ...deployHeaders },
    }, 30000, undefined, account);
    const json = await resp.json() as any;
    return json.result || json;
  }

  // 分类文件
  const specialFiles: Array<{ name: string; buffer: Buffer; contentType: string }> = [];
  const assetFiles: Array<{ path: string; buffer: Buffer; contentType: string }> = [];

  for (const f of files) {
    const cleanPath = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const basename = cleanPath.split('/').pop() || cleanPath;
    if (!cleanPath.includes('/') && SPECIAL_FILES.has(basename)) {
      specialFiles.push({ name: basename, buffer: f.buffer, contentType: getContentType(basename) });
    } else {
      assetFiles.push({ path: cleanPath, buffer: f.buffer, contentType: getContentType(cleanPath) });
    }
  }

  // Step 1: 获取 upload JWT
  const fetchJwt = async () => {
    const resp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}/upload-token`, {
      headers: { ...deployHeaders },
    }, 30000, undefined, account);
    if (!resp.ok) throw new Error(`Failed to get upload token: ${resp.status}`);
    const json = await resp.json() as any;
    if (!json?.result?.jwt) throw new Error(`Upload token response missing jwt: ${JSON.stringify(json)}`);
    return json.result.jwt as string;
  };
  const jwt = await fetchJwt();

  // Step 2: 计算 hash + check-missing
  const manifest: Record<string, string> = {};
  const hashToFile = new Map<string, { buffer: Buffer; contentType: string }>();

  for (const f of assetFiles) {
    const manifestKey = '/' + f.path;
    const hash = await computeStaticAssetHash(f.buffer, f.path);
    manifest[manifestKey] = hash;
    if (!hashToFile.has(hash)) {
      hashToFile.set(hash, { buffer: f.buffer, contentType: f.contentType });
    }
  }

  const allHashes = [...hashToFile.keys()];

  // check-missing with JWT refresh
  const checkMissing = async (currentJwt: string): Promise<string[]> => {
    const resp = await proxyFetch(`${CF_BASE}/pages/assets/check-missing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentJwt}`,
        'User-Agent': 'wrangler/4.112.0',
      },
      body: JSON.stringify({ hashes: allHashes }),
    }, 30000, undefined, account);
    if (!resp.ok) throw new Error(`check-missing failed: ${resp.status}`);
    const json = await resp.json() as any;
    return json.result || [];
  };

  let missingHashes: string[] = [];
  let currentJwt = jwt;
  for (let attempt = 0; attempt <= MAX_JWT_RETRIES; attempt++) {
    try {
      missingHashes = await withRetry(() => checkMissing(currentJwt));
      break;
    } catch (e: any) {
      if (attempt < MAX_JWT_RETRIES && isJwtExpired(currentJwt)) {
        appLogger.info(`[Pages Deploy] JWT expired during check-missing, refreshing...`);
        currentJwt = await fetchJwt();
      } else {
        throw e;
      }
    }
  }

  appLogger.info(`[Pages Deploy] Missing assets: ${missingHashes.length}/${allHashes.length}`);

  // Step 3: 上传缺失的资源
  if (missingHashes.length > 0) {
    const BATCH_SIZE = 50;

    for (let i = 0; i < missingHashes.length; i += BATCH_SIZE) {
      const batch = missingHashes.slice(i, i + BATCH_SIZE);
      const payload: Array<{ key: string; value: string; metadata: { contentType: string }; base64: boolean }> = [];

      for (const hash of batch) {
        const fileInfo = hashToFile.get(hash);
        if (!fileInfo) continue;
        payload.push({
          key: hash,
          value: fileInfo.buffer.toString('base64'),
          metadata: { contentType: fileInfo.contentType },
          base64: true,
        });
      }

      // Upload with retry + JWT refresh
      const uploadBatch = async (jwtToUse: string) => {
        const resp = await proxyFetch(`${CF_BASE}/pages/assets/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToUse}`,
            'User-Agent': 'wrangler/4.112.0',
          },
          body: JSON.stringify(payload),
        }, 300000, undefined, account);
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Asset upload failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${resp.status} ${text}`);
        }
      };

      for (let attempt = 0; attempt <= MAX_JWT_RETRIES; attempt++) {
        try {
          await withRetry(() => uploadBatch(currentJwt));
          break;
        } catch (e: any) {
          if (attempt < MAX_JWT_RETRIES && isJwtExpired(currentJwt)) {
            appLogger.info(`[Pages Deploy] JWT expired during upload, refreshing...`);
            currentJwt = await fetchJwt();
          } else {
            throw e;
          }
        }
      }
    }

    // upsert-hashes (non-fatal)
    try {
      await proxyFetch(`${CF_BASE}/pages/assets/upsert-hashes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentJwt}`,
          'User-Agent': 'wrangler/4.112.0',
        },
        body: JSON.stringify({ hashes: allHashes }),
      }, 30000, undefined, account);
    } catch (e: any) {
      appLogger.warn(`[Pages Deploy] upsert-hashes failed (non-fatal): ${e.message}`);
    }
  }

  // Step 4: 创建 deployment（与 wrangler 保持一致：可选字段仅在存在时添加）
  // 手动构建 multipart：走代理时 node-fetch 无法序列化 FormData（CF 返回 415）
  const deployParts: MultipartPart[] = [
    { name: 'manifest', value: JSON.stringify(manifest) },
  ];

  if (opts.branch) {
    deployParts.push({ name: 'branch', value: opts.branch });
  }

  if (opts.commitMessage) {
    deployParts.push({ name: 'commit_message', value: opts.commitMessage.length > 384
      ? opts.commitMessage.slice(0, 384)
      : opts.commitMessage });
  }

  if (opts.commitHash) {
    deployParts.push({ name: 'commit_hash', value: opts.commitHash });
  }

  if (opts.commitDirty !== undefined) {
    deployParts.push({ name: 'commit_dirty', value: String(opts.commitDirty) });
  }

  for (const sf of specialFiles) {
    if (sf.name === '_worker.bundle') {
      // _worker.bundle 文件本身就是 wrangler 预先序列化好的 multipart/form-data 二进制
      // 直接原样上传，不要重新包装！
      deployParts.push({ name: sf.name, value: sf.buffer, filename: sf.name, contentType: 'application/octet-stream' });
    } else if (sf.name === '_worker.js') {
      // _worker.js 是单文件 JS 入口，需要包装为内层 multipart(metadata + module)
      const inner = buildMultipartBody([
        { name: 'metadata', value: JSON.stringify({ main_module: '_worker.js' }) },
        { name: '_worker.js', value: sf.buffer.toString('utf-8'), filename: '_worker.js' },
      ]);
      deployParts.push({ name: sf.name, value: inner.body, filename: sf.name, contentType: inner.contentType });
    } else if (TEXT_SPECIAL_FILES.has(sf.name)) {
      // _routes.json / _headers / _redirects / functions-filepath-routing-config.json
      // 全部 UTF-8 字符串 → 无 Content-Type（对齐 undici 对 File(type='') 的处理）
      deployParts.push({ name: sf.name, value: sf.buffer.toString('utf-8'), filename: sf.name });
    } else {
      deployParts.push({ name: sf.name, value: sf.buffer, filename: sf.name, contentType: sf.contentType });
    }
  }

  const { body: deployBody, contentType: deployContentType } = buildMultipartBody(deployParts);

  const deployResp = await withRetry(() =>
    proxyFetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}/deployments`, {
      method: 'POST',
      headers: { ...deployHeaders, 'Content-Type': deployContentType },
      body: deployBody,
    }, 300000, undefined, account),
  );
  const deployJson = await deployResp.json() as any;
  if (!deployResp.ok || !deployJson.success) {
    throw new Error(`Pages deploy failed: ${deployResp.status} ${JSON.stringify(deployJson)}`);
  }

  // Step 5: 轮询部署状态
  const deploymentId = deployJson?.result?.id;
  if (deploymentId) {
    const pollResult = await pollDeploymentStatus(account, name, deploymentId);
    if (pollResult.status === 'failure') {
      appLogger.warn(`[Pages Deploy] Deployment build stage failed: ${pollResult.logs || 'unknown error'}`);
    } else {
      appLogger.info(`[Pages Deploy] Deployment status: ${pollResult.status}`);
    }
  }

  return deployJson.result;
}
