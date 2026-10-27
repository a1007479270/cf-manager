import { Account } from '../../models/account';
import { getDeployHeaders } from './headers';
import { computeStaticAssetHash, getContentType } from '../staticAssets';
import { appLogger } from '../logger';
import { proxyFetch } from '../proxyService';
import { buildMultipartBody, type MultipartPart } from './uploadForm';

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_RETRIES = 3;

// 构造 Workers Assets manifest：路径以 "/" 开头，hash 与后端/Worker 资产算法一致。
async function buildAssetsManifest(
  files: Array<{ path: string; buffer: Buffer }>,
): Promise<Record<string, { hash: string; size: number }>> {
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const f of files) {
    const key = '/' + f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    manifest[key] = { hash: await computeStaticAssetHash(f.buffer, f.path), size: f.buffer.length };
  }
  return manifest;
}

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

/**
 * Worker 静态资源三阶段上传（与 wrangler 同款）：
 *   1) POST .../assets-upload-session 提交 manifest → 返回 { jwt, buckets }
 *      - buckets 非空：jwt 是 upload token，需按 buckets 分批上传缺失文件
 *      - buckets 为空：所有资源已存在，jwt 直接就是 completion token，跳过阶段 2
 *   2) POST .../workers/assets/upload?base64=true 按 bucket 分批 multipart 上传（field=hash, value=base64）
 *   3) 返回 completion jwt，挂到 metadata.assets.jwt
 */
export async function deployWorkerAssets(
  account: Account,
  scriptName: string,
  files: Array<{ path: string; buffer: Buffer }>,
): Promise<{ jwt: string }> {
  const deployHeaders = getDeployHeaders(account);
  const accountId = account.account_id!;

  // 预计算 hash → buffer 映射，用于按 buckets 选择性上传
  const manifest = await buildAssetsManifest(files);
  const hashToBuffer = new Map<string, Buffer>();
  const hashToPath = new Map<string, string>();
  for (const f of files) {
    const hash = await computeStaticAssetHash(f.buffer, f.path);
    if (!hashToBuffer.has(hash)) {
      hashToBuffer.set(hash, f.buffer);
      hashToPath.set(hash, f.path);
    }
  }

  // Stage 1: assets-upload-session
  const sessionResp = await withRetry(() =>
    proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deployHeaders },
      body: JSON.stringify({ manifest }),
    }, 300000, undefined, account),
  );
  const sessionJson = await sessionResp.json() as any;
  const sessionJwt: string | undefined = sessionJson?.result?.jwt;
  const buckets: string[][] = sessionJson?.result?.buckets || [];
  if (!sessionResp.ok || !sessionJson?.success || !sessionJwt) {
    throw new Error(
      `assets-upload-session failed: status=${sessionResp.status} success=${sessionJson?.success} ` +
      `hasJwt=${!!sessionJwt} errors=${JSON.stringify(sessionJson?.errors || sessionJson?.messages || '').slice(0, 400)}`,
    );
  }

  // buckets 为空 → 所有资源已存在，sessionJwt 即为 completion token，直接返回（跳过上传）
  if (buckets.length === 0) {
    appLogger.info(`[Worker Assets] All ${files.length} assets already uploaded, using completion JWT directly`);
    return { jwt: sessionJwt };
  }

  // Stage 2: 按 buckets 分批上传
  // 每批次上传后 CF 返回新的 JWT，下一批次必须用新 JWT（对标 wrangler syncAssets）
  const totalHashes = buckets.reduce((n, b) => n + b.length, 0);
  appLogger.info(`[Worker Assets] Uploading ${totalHashes} assets in ${buckets.length} bucket(s)`);
  let completionJwt = sessionJwt;
  for (let bi = 0; bi < buckets.length; bi++) {
    const bucket = buckets[bi];
    // 手动构建 multipart：走代理时 node-fetch 无法序列化 FormData（CF 返回 415）
    const upParts: MultipartPart[] = [];
    for (const hash of bucket) {
      const buf = hashToBuffer.get(hash);
      if (!buf) {
        appLogger.warn(`[Worker Assets] Hash ${hash} not found in local files, skipping`);
        continue;
      }
      // MIME 类型至关重要：CF 按此值设置响应 Content-Type。
      // 用 octet-stream 会导致浏览器拒绝加载 JS 模块。
      const filePath = hashToPath.get(hash) || '';
      const ct = getContentType(filePath);
      upParts.push({ name: hash, value: buf.toString('base64'), filename: hash, contentType: ct });
    }
    const { body: upBody, contentType: upContentType } = buildMultipartBody(upParts);
    const upResp = await withRetry(() =>
      proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${completionJwt}`, 'User-Agent': 'wrangler/4.112.0', 'Content-Type': upContentType },
        body: upBody,
      }, 300000, undefined, account),
    );
    if (!upResp.ok) {
      const txt = await upResp.text();
      throw new Error(`assets upload failed (bucket ${bi + 1}/${buckets.length}): ${upResp.status} ${txt} (jwtLen=${completionJwt.length})`);
    }
    const upJson = await upResp.json() as any;
    if (upJson.result?.jwt) completionJwt = upJson.result.jwt;
  }
  if (!completionJwt) throw new Error(`assets upload response missing completion jwt`);
  return { jwt: completionJwt };
}
