import { Account } from '../models/account';
import { getCfClient, getAuthHeaders } from './cfFactory';
import { proxyFetch, buildCurlCommand } from './proxyService';
import { fetchScriptSafely } from './ssrfGuard';
import { appLogger } from './logger';
import { computeStaticAssetHash, getContentType, extractZipFiles } from './staticAssets';
import { buildMultipartBody, type MultipartPart } from './deploy/uploadForm';
export { extractZipFiles };
export * from './pagesService';
export * from './workerConfig';




export interface WorkerScript {
  id: string;
  name?: string;
  created_on: string;
  modified_on: string;
  etag: string;
  handlers: string[];
}

export interface DeployWorkerOptions {
  bindings?: Record<string, unknown>[];
  env?: Record<string, string>;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  enableSubdomain?: boolean;
  createDeployment?: boolean;
  deploymentAnnotation?: Record<string, string>;
}


// Worker with Assets 的静态资源来源（复用 catalog 的 #/$defs/source 形态）。
export interface WorkerAssetsInput {
  source: { kind: string; url: string; assetName?: string; subPath?: string };
  binding?: string;
  config?: { html_handling?: string; not_found_handling?: string };
}



// 构造 Workers Assets manifest：路径以 "/" 开头，hash 与后端/Worker 资产算法一致。
export async function buildAssetsManifest(
  files: Array<{ path: string; buffer: Buffer }>,
): Promise<Record<string, { hash: string; size: number }>> {
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const f of files) {
    const key = '/' + f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    manifest[key] = { hash: await computeStaticAssetHash(f.buffer, f.path), size: f.buffer.length };
  }
  return manifest;
}

export interface DeployWorkerResult {
  script: any;
  subdomain?: string;
}

export async function listWorkers(account: Account): Promise<WorkerScript[]> {
  const accountId = account.account_id;
  if (!accountId) return [];
  const cf = getCfClient(account);
  const scripts: WorkerScript[] = [];
  for await (const script of cf.workers.scripts.list({ account_id: accountId })) {
    scripts.push(script as any);
  }
  return scripts;
}

const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function getAccountSubdomain(account: Account): Promise<string> {
  const headers = getAuthHeaders(account);
  try {
    const resp = await proxyFetch(`${CF_BASE}/accounts/${account.account_id}/workers/subdomain`, {
      headers: { 'Content-Type': 'application/json', ...headers },
    }, 30000, undefined, account);
    if (!resp.ok) return '';
    const json = await resp.json() as any;
    return json?.result?.subdomain || '';
  } catch {
    return '';
  }
}

// 三阶段上传 Worker 静态资源（与 wrangler 同款）：
//   1) POST .../assets-upload-session 提交 manifest → 返回 { jwt, buckets }
//      - buckets 非空：jwt 是 upload token，需按 buckets 分批上传缺失文件
//      - buckets 为空：所有资源已存在，jwt 直接就是 completion token，跳过阶段 2
//   2) POST .../workers/assets/upload?base64=true 按 bucket 分批 multipart 上传（field=hash, value=base64）
//   3) 返回 completion jwt，挂到 metadata.assets.jwt
async function deployWorkerAssets(
  account: Account,
  scriptName: string,
  files: Array<{ path: string; buffer: Buffer }>,
): Promise<{ jwt: string }> {
  const authHeaders = getAuthHeaders(account);
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

  const sessionResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders, 'User-Agent': 'wrangler/4.112.0' },
    body: JSON.stringify({ manifest }),
  }, 300000, undefined, account);
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

  // 按 buckets 分批上传：每个 bucket 是一批需要一起上传的 hash 列表
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
      // MIME 类型至关重要：CF 按此值设置响应 Content-Type，缺失会导致浏览器拒绝加载 JS 模块
      upParts.push({ name: hash, value: buf.toString('base64'), filename: hash, contentType: getContentType(hashToPath.get(hash) || '') });
    }
    const { body: upBody, contentType: upContentType } = buildMultipartBody(upParts);
    const upResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${completionJwt}`, 'User-Agent': 'wrangler/4.112.0', 'Content-Type': upContentType },
      body: upBody,
    }, 300000, undefined, account);
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

// 下载 assets 产物（zip 或 raw 单文件），与 catalogDeploy 的 downloadArtifact 同源。
async function downloadArtifactForAssets(src: WorkerAssetsInput['source']): Promise<Buffer> {
  const resp = await proxyFetch(src.url, {}, 30000);
  if (!resp.ok) throw new Error(`assets 产物下载失败: ${resp.status} ${src.url}`);
  return Buffer.from(await resp.arrayBuffer());
}

// 推断多模块入口文件名：优先显式 mainModule；其次 wrangler.toml/jsonc 的 main 字段；
// 仅 1 个模块时直接用；多模块时按常见入口名优先级（worker.js → index.js/index.mjs → 根目录首个 JS）查找；最后回退 'worker.js'。
export function resolveMainModule(modules: Array<{ path: string; buffer: Buffer }> | null, explicit?: string): string {
  if (explicit) return explicit;
  if (!modules || modules.length === 0) return 'worker.js';
  const conf = modules.find(m => /^wrangler\.(toml|jsonc|json)$/i.test(m.path));
  if (conf) {
    const txt = conf.buffer.toString('utf-8');
    const m = txt.match(/^\s*main\s*=\s*"([^"]+)"/m) || txt.match(/"main"\s*:\s*"([^"]+)"/m);
    if (m) return m[1].replace(/^\.\//, '');
  }
  if (modules.length === 1) return modules[0].path;
  const candidates = ['worker.js', 'index.js', 'index.mjs', 'worker.mjs', 'index.cjs', 'worker.cjs'];
  for (const c of candidates) {
    if (modules.some(m => m.path === c)) return c;
  }
  const root = modules.find(m => /^[^/\\]+\.(m?js|cjs)$/i.test(m.path));
  if (root) return root.path;
  return 'worker.js';
}

export async function deployWorker(
  account: Account,
  name: string,
  scriptContent: string | Buffer,
  options?: DeployWorkerOptions & {
    packageZip?: Buffer;        // 多模块 zip：本地解压后每个文件作为一个 files= part（与 wrangler 本地解包一致）
    mainModule?: string;        // 多模块入口文件名（默认从 zip 推断，回退 'worker.js'）
    assets?: WorkerAssetsInput;
    assetsBuffer?: Buffer;
    traces?: boolean;           // Workers 跟踪（Workers Observability，含链路追踪/指标）。默认开启
    logs?: boolean;             // Workers 日志（嵌套在 observability.logs.invocation_logs）。默认开启
  },
): Promise<DeployWorkerResult> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const cf = getCfClient(account);
  const authHeaders = getAuthHeaders(account);

  // 多模块：若提供 packageZip，本地解压为多个模块文件（与 wrangler 行为一致）。
  const moduleParts = options?.packageZip ? extractZipFiles(options.packageZip) : null;
  const mainModule = resolveMainModule(moduleParts, options?.mainModule);

  // 推断需要的兼容性标志：含 CJS 互操作（__commonJS/require）或访问 process/Buffer/node:
  // 构建产物（如 React Router v7 on Workers）必须开启 nodejs_compat，否则运行时抛异常（Error 1101）。
  const flags = new Set<string>(options?.compatibilityFlags || []);
  const probe = (buf: Uint8Array | Buffer | string) => {
    const s = typeof buf === 'string' ? buf : Buffer.from(buf).toString('latin1');
    // process\. 捕获 process.env / process.platform / process.versions 等所有 process 访问；
    // global\.process 捕获打包器生成的 global.process 互操作。这些在未开启 nodejs_compat 时会抛 ReferenceError。
    return /__commonJS|function __require|\brequire\(|from ["']node:|\bprocess\.|globalThis\.process|global\.process|\bBuffer\.|node:async_hooks/.test(s);
  };
  let needsNodeCompat = false;
  if (moduleParts && moduleParts.length > 0) {
    needsNodeCompat = moduleParts.some(m => probe(m.buffer));
  } else if (scriptContent) {
    needsNodeCompat = probe(scriptContent);
  }
  if (needsNodeCompat) flags.add('nodejs_compat');

  // Build metadata with optional bindings and env vars
  const metadata: any = {
    main_module: moduleParts && moduleParts.length > 0 ? mainModule : 'worker.js',
    compatibility_date: options?.compatibilityDate || '2024-11-01',
  };
  if (flags.size > 0) metadata.compatibility_flags = [...flags];

  // Workers 跟踪 / 日志开关（缺省均开启，与 store 部署一致）。
  // 注意：Cloudflare 不会从上传脚本的 metadata 读取 observability，必须等脚本上传成功后
  // 通过独立的 settings/observability 端点设置（见下方提交上传后的 applyObservability）。
  const tracesEnabled = options?.traces !== false;   // Workers 跟踪
  const logsEnabled = options?.logs !== false;        // Workers 日志

  if (options?.bindings?.length) {
    metadata.bindings = options.bindings;
  }

  if (options?.env) {
    metadata.bindings = [
      ...(metadata.bindings || []),
      ...Object.entries(options.env).map(([k, v]) => ({ type: 'plain_text', name: k, text: v })),
    ];
  }

  // Worker with Assets：可选静态资源三阶段上传，并注入 ASSETS 绑定（默认 ASSETS，可覆盖）。
  if (options?.assets) {
    const assetContent: Buffer = options.assetsBuffer
      ? options.assetsBuffer
      : await downloadArtifactForAssets(options.assets.source);
    const assetFiles = options.assets.source.kind === 'raw'
      ? [{ path: options.assets.source.url.split('/').pop() || 'asset', buffer: assetContent }]
      : extractZipFiles(assetContent);
    const { jwt } = await deployWorkerAssets(account, name, assetFiles);
    metadata.assets = { jwt, config: options.assets.config || undefined };
    metadata.bindings = [...(metadata.bindings || []), { name: options.assets.binding || 'ASSETS', type: 'assets' }];
  }

  // 多模块 zip（如 React Router on Workers）解压出的每个文件都要作为 Worker 模块上传：
  // index.js 入口会 import assets/*.js 等代码分片，它们必须随脚本一起上传，否则 CF 报
  // "No such module"。注意：静态资源（assets 绑定）由下面的 deployWorkerAssets 单独上传，
  // 与这里的模块上传是两条独立通道，不要在此排除 assets/。
  const moduleFiles = moduleParts;

  // 手动构建 multipart（不用 new FormData()）：proxyFetch 配置代理时走 node-fetch，
  // 无法序列化内置 FormData 也不会补 Content-Type，CF 会返回 415；
  // SDK 的 scripts.update 在部分版本也会破坏 multipart，故统一走 fetch + 手工拼 body。
  const scriptParts: MultipartPart[] = [
    { name: 'metadata', value: JSON.stringify(metadata), contentType: 'application/json' },
  ];

  if (moduleFiles && moduleFiles.length > 0) {
    // 多模块：zip 解压出的每个文件一个 part，main_module 指向入口文件
    if (!moduleFiles.some(m => m.path === mainModule)) {
      throw new Error(`main_module "${mainModule}" 未在 zip 模块中找到（已包含: ${moduleFiles.map(m => m.path).join(', ')}）`);
    }
    for (const m of moduleFiles) {
      const isJs = /\.(m?js|cjs)$/i.test(m.path);
      scriptParts.push({ name: m.path, value: m.buffer, filename: m.path, contentType: isJs ? 'application/javascript+module' : getContentType(m.path) });
    }
  } else {
    // 单模块（默认）：兼容旧路径，脚本内容即 worker.js
    const contentBytes = typeof scriptContent === 'string'
      ? new TextEncoder().encode(scriptContent)
      : new Uint8Array(scriptContent);
    scriptParts.push({ name: 'worker.js', value: contentBytes, filename: 'worker.js', contentType: 'application/javascript+module' });
  }
  const { body: scriptBody, contentType: scriptContentType } = buildMultipartBody(scriptParts);

  // 版本化优先（对齐 Store 部署通道 workerDeploy.ts）：
  // 版本化 worker 下传统 PUT 的 metadata.bindings 会被 CF 忽略，必须用 Versions API 提交才能让 vars/bindings 生效。
  // - script 已存在 → POST /versions?bindings_inherit=strict（创建带 bindings 的新版本）+ POST /deployments
  // - script 不存在 → 传统 PUT 创建（首次部署，自动上线）
  const checkResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
    headers: { ...authHeaders, 'User-Agent': 'wrangler/4.112.0' },
  }, 30000, undefined, account);
  let respJson: any;
  if (checkResp.status === 404) {
    const createResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'User-Agent': 'wrangler/4.112.0', 'Content-Type': scriptContentType },
      body: scriptBody,
    }, 300000, undefined, account);
    respJson = await createResp.json() as any;
    if (!createResp.ok || !respJson.success) {
      throw new Error(`Script creation failed: ${createResp.status} ${JSON.stringify(respJson)}`);
    }
  } else if (!checkResp.ok) {
    const errBody = await checkResp.text();
    throw new Error(`Script existence check failed: ${checkResp.status} ${errBody.slice(0, 300)}`);
  } else {
    // 已存在：优先 Versions API（版本化 worker 下 bindings 才能生效）
    const versionResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/versions?bindings_inherit=strict`, {
      method: 'POST',
      headers: { ...authHeaders, 'User-Agent': 'wrangler/4.112.0', 'Content-Type': scriptContentType },
      body: scriptBody,
    }, 300000, undefined, account);
    const versionJson = await versionResp.json() as any;
    if (versionResp.ok && versionJson.success) {
      respJson = versionJson;
    } else {
      // 非版本化 worker：versions API 不可用，fallback 传统 PUT（PUT 自动部署）
      appLogger.warn(`[Worker Deploy] Versions API unavailable for ${name} (${versionResp.status}), falling back to PUT`);
      const putResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
        method: 'PUT',
        headers: { ...authHeaders, 'User-Agent': 'wrangler/4.112.0', 'Content-Type': scriptContentType },
        body: scriptBody,
      }, 300000, undefined, account);
      respJson = await putResp.json() as any;
      if (!putResp.ok || !respJson.success) {
        throw new Error(`${putResp.status} ${JSON.stringify(respJson)}`);
      }
    }
  }
  console.log(`[DBG] deployWorker upload status=ok success=${respJson.success} versionId=${respJson?.result?.version_id || respJson?.result?.id || respJson?.result?.version?.id}`);

  // 设置可观测性（Workers 跟踪 + 日志）。Cloudflare 不读取上传 metadata 中的 observability，
  // 必须通过独立的 PATCH script-settings 端点设置（observability 作为嵌套字段）；脚本上传成功后再调用。
  // 两者都关闭时跳过调用，避免无谓的 API 请求（及账户无权限时的报错）。
  if (tracesEnabled || logsEnabled) {
    // 顶层 enabled 是总开关，任一子项开启都必须为 true；traces/logs 需作为独立子对象发送。
    const obsBody: Record<string, unknown> = { enabled: true, head_sampling_rate: 1 };
    if (tracesEnabled) obsBody.traces = { enabled: true, persist: true, head_sampling_rate: 1 };
    if (logsEnabled) obsBody.logs = { enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1 };
    const obsResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/script-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders, 'User-Agent': 'wrangler/4.112.0' },
      body: JSON.stringify({ observability: obsBody }),
    }, 30000, undefined, account);
    if (!obsResp.ok) {
      const obsErr = await obsResp.text();
      throw new Error(`设置 Workers 可观测性失败 (${obsResp.status}): ${obsErr}`);
    }
  }

  // 从上传响应中提取 version_id（版本化 API 下需要用它创建 deployment）
  // 注意：传统 PUT 的 result.id 是脚本名（如 "smail"），不能用作回退；POST /versions 的 result.id 才是版本 ID
  let versionId: string | undefined =
    respJson?.result?.version_id ||
    respJson?.result?.version?.id ||
    respJson?.result?.id;

  // Enable workers.dev subdomain so the Worker is accessible immediately
  let subdomain: string | undefined;
  const shouldEnableSubdomain = options?.enableSubdomain !== false; // default true
  if (shouldEnableSubdomain) {
    try {
      await cf.workers.scripts.subdomain.create(name, { account_id: accountId, enabled: true, previews_enabled: true } as any);
    } catch (_) {
      // Soft fail: user can still enable manually from settings drawer
    }

    // Get account-level subdomain for URL construction
    subdomain = await getAccountSubdomain(account);
  }

  // Create deployment：版本化 API 下 PUT 只创建版本不部署，必须显式创建 deployment 才能上线。
  // 经典 API 下 PUT 已直接部署，createDeployment 仅用于版本追踪（非必需）。
  // 必须有 version_id 才能创建 deployment，否则 API 报 versions:[] 无效。
  if (options?.createDeployment) {
    try {
      // 若 PUT 响应未携带 version_id，查询版本列表获取最新版本 ID
      if (!versionId) {
        try {
          const versionsResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/versions`, {
            headers: { ...authHeaders, 'User-Agent': 'wrangler/4.112.0' },
          }, 30000, undefined, account);
          if (versionsResp.ok) {
            const versionsJson = await versionsResp.json() as any;
            const versions = versionsJson?.result || [];
            if (versions.length > 0) {
              versionId = versions[0]?.id; // 版本列表按 created_on 降序，首个即最新
            }
          }
        } catch {
          // 经典模式：versions 端点不可用，PUT 已直接部署
        }
      }

      // 有 version_id 才发 deployment 请求；没有则跳过（PUT 已部署，createDeployment 非必需）
      if (versionId) {
        const depResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/deployments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders, 'User-Agent': 'wrangler/4.112.0' },
          body: JSON.stringify({
            strategy: 'percentage',
            versions: [{ percentage: 100, version_id: versionId }],
            annotations: options.deploymentAnnotation || {},
          }),
        }, 30000, undefined, account);
        if (!depResp.ok) {
          const depTxt = await depResp.text();
          // 失败必须抛错：否则 batch-deploy 会误判为 success，前端乐观显示「保存成功」但实际版本未上线
          throw new Error(`[Worker Deploy] Deployment creation failed for ${name}: ${depResp.status} ${depTxt.slice(0, 500)}`);
        }
      }
    } catch (e: any) {
      appLogger.warn(`[Worker Deploy] Deployment creation warning for ${name}: ${e.message}`);
    }
  }

  return { script: respJson.result, subdomain };
}

// Deploy worker from URL: fetch JS from remote URL then upload
export async function deployWorkerFromUrl(
  account: Account, name: string, url: string, options?: DeployWorkerOptions & { assets?: WorkerAssetsInput; assetsBuffer?: Buffer },
): Promise<DeployWorkerResult> {
  const scriptContent = await fetchScriptSafely(url);
  return deployWorker(account, name, scriptContent, options);
}

export async function deleteWorker(account: Account, name: string): Promise<void> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  await cf.workers.scripts.delete(name, { account_id: accountId! } as any);
}

export async function getWorkerLogs(account: Account, name: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const result = await cf.workers.scripts.tail.get(name, { account_id: accountId! } as any);
  return result;
}

// ============ Worker Settings ============

// --- Secrets ---
export async function listSecrets(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const secrets: any[] = [];
  for await (const s of cf.workers.scripts.secrets.list(scriptName, { account_id: accountId! })) {
    secrets.push(s);
  }
  return secrets;
}

export async function updateSecret(account: Account, scriptName: string, secretName: string, type: string, text?: string, keyBase64?: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const params: any = { account_id: accountId!, name: secretName, type };
  if (type === 'secret_text') params.text = text;
  if (type === 'secret_key') params.key_base64 = keyBase64;
  return await cf.workers.scripts.secrets.update(scriptName, params);
}

export async function deleteSecret(account: Account, scriptName: string, secretName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.secrets.delete(scriptName, secretName, { account_id: accountId! });
}

// --- Cron Schedules ---
export async function getSchedules(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.schedules.get(scriptName, { account_id: accountId! });
}

export async function updateSchedules(account: Account, scriptName: string, crons: string[]): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.schedules.update(scriptName, {
    account_id: accountId!,
    body: crons.map(c => ({ cron: c })),
  });
}

// --- Custom Domains ---
export async function listDomains(account: Account, serviceName?: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const domains: any[] = [];
  const params: any = { account_id: accountId! };
  if (serviceName) params.service = serviceName;
  for await (const d of cf.workers.domains.list(params)) {
    domains.push(d);
  }
  return domains;
}

export async function createDomain(account: Account, hostname: string, service: string, environment?: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const params: any = { account_id: accountId!, hostname, service };
  if (environment) params.environment = environment;
  return await cf.workers.domains.update(params);
}

export async function deleteDomain(account: Account, domainId: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.domains.delete(domainId, { account_id: accountId! });
}

// --- Subdomain (workers.dev) ---
export async function getSubdomain(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const raw: any = await cf.workers.scripts.subdomain.get(scriptName, { account_id: accountId! });
  // 额外拉取账户级 workers.dev 子域名，供前端拼出完整 URL：https://<script>.<accountSubdomain>.workers.dev
  const accountSubdomain = await getAccountSubdomain(account);
  const enabled = raw?.enabled;
  const previews_enabled = raw?.previews_enabled;
  const url = accountSubdomain ? `https://${scriptName}.${accountSubdomain}.workers.dev` : '';
  return { enabled, previews_enabled, accountSubdomain, url };
}

export async function setSubdomain(account: Account, scriptName: string, enabled: boolean): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.subdomain.create(scriptName, { account_id: accountId!, enabled });
}

// --- Script Settings ---
export async function getScriptSettings(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.settings.get(scriptName, { account_id: accountId! });
}

export async function updateScriptSettings(account: Account, scriptName: string, settings: any): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.settings.edit(scriptName, { account_id: accountId!, ...settings });
}

// --- Routes ---
export async function listRoutes(account: Account, zoneId: string): Promise<any[]> {
  const cf = getCfClient(account);
  const routes: any[] = [];
  for await (const r of cf.workers.routes.list({ zone_id: zoneId })) {
    routes.push(r);
  }
  return routes;
}

export async function createRoute(account: Account, zoneId: string, pattern: string, script?: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.workers.routes.create({ zone_id: zoneId, pattern, script });
}

export async function deleteRoute(account: Account, zoneId: string, routeId: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.workers.routes.delete(routeId, { zone_id: zoneId });
}

// --- Script Content ---
// Cloudflare GET /accounts/{id}/workers/scripts/{name} 返回 multipart/form-data，
// 真正的脚本内容在 `worker.js` 字段里。SDK 拿到的就是原始 multipart body，
// 这里用原生 fetch + 自写解析器抠出 worker.js。
export async function getScriptContent(account: Account, scriptName: string): Promise<string> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`;
  const resp = await proxyFetch(url, { headers: { ...getAuthHeaders(account), Accept: '*/*' } }, 30000, undefined, account);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch script content: ${resp.status} ${text.slice(0, 200)}`);
  }
  const contentType = resp.headers.get('content-type') || '';
  const buf = Buffer.from(await resp.arrayBuffer());
  // 如果不是 multipart，直接当文本返回（兼容未来 CF 改为纯文本的情况）
  if (!/multipart\/form-data/i.test(contentType)) {
    return buf.toString('utf-8');
  }
  // 解析 multipart：取 boundary，按 boundary 切片，每段查找 Content-Disposition 含 worker.js 的
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) return buf.toString('utf-8');
  const delim = Buffer.from(`--${boundary}`);
  const start = buf.indexOf(delim);
  if (start < 0) return buf.toString('utf-8');
  const parts: Buffer[] = [];
  let pos = start;
  while (pos < buf.length) {
    const next = buf.indexOf(delim, pos + delim.length);
    const seg = next < 0 ? buf.subarray(pos + delim.length) : buf.subarray(pos + delim.length, next);
    if (seg.length > 0) parts.push(seg);
    if (next < 0) break;
    pos = next;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.subarray(0, headerEnd).toString('utf-8');
    if (!/name="worker\.js"/i.test(headers)) continue;
    // body 是 headerEnd+4 到末尾，去掉尾部 \r\n
    let body = part.subarray(headerEnd + 4);
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 2);
    }
    return body.toString('utf-8');
  }
  return buf.toString('utf-8');
}

// --- Deployments ---
export async function listDeployments(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.deployments.list(scriptName, { account_id: accountId! });
}

// ============ Cloudflare Resources (for Pages bindings) ============
// P1-12/13: KV 命名空间列表 TTL 缓存（单进程内存；创建/删除后至多 60s 内可见，避免每次刷新打 CF）
const KV_LIST_TTL_MS = 60 * 1000;
const kvListCache = new Map<string, { data: any[]; fetchedAt: number }>();
export async function listKvNamespaces(account: Account): Promise<any[]> {
  const cacheKey = String(account.account_id);
  const cached = kvListCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < KV_LIST_TTL_MS) {
    return cached.data;
  }
  const cf = getCfClient(account);
  const items: any[] = [];
  for await (const ns of cf.kv.namespaces.list({ account_id: account.account_id! })) {
    items.push(ns);
  }
  kvListCache.set(cacheKey, { data: items, fetchedAt: Date.now() });
  return items;
}

export async function listD1Databases(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const items: any[] = [];
  for await (const db of cf.d1.database.list({ account_id: account.account_id! })) {
    items.push(db);
  }
  return items;
}

export async function listR2Buckets(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const resp: any = await cf.r2.buckets.list({ account_id: account.account_id! });
  return resp?.buckets || [];
}

// ============ Workers Usage (GraphQL) ============
export interface WorkersUsage {
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeMs: number;
}

function getTodayMidnightUTC(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function getWorkersUsageToday(account: Account): Promise<WorkersUsage> {
  const accountId = account.account_id;
  if (!accountId) return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };

  const now = new Date();
  const todayDate = now.toISOString().substring(0, 10);
  const datetimeStart = getTodayMidnightUTC();
  const datetimeEnd = now.toISOString();

  const query = `
    query CfWorkersUsage($accountTag: string!, $datetimeStart: Time!, $datetimeEnd: Time!, $todayDate: Date!) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          workers: workersInvocationsAdaptive(
            filter: {
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd
            }
            limit: 10000
          ) {
            sum {
              requests
              errors
              subrequests
              cpuTimeUs
            }
          }
          pages: pagesFunctionsInvocationsAdaptiveGroups(
            filter: {
              date: $todayDate
            }
            limit: 1
          ) {
            sum {
              requests
              errors
            }
          }
        }
      }
    }
  `;

  const headers = getAuthHeaders(account);
  const fetchUrl = 'https://api.cloudflare.com/client/v4/graphql';
  const fetchInit = {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { accountTag: accountId, datetimeStart, datetimeEnd, todayDate },
    }),
  };
  let resp;
  try {
    resp = await proxyFetch(fetchUrl, fetchInit, 12000, undefined, account);
  } catch (e) {
    appLogger.error(`[Workers Usage] Fetch failed for ${account.name}: ${e}\n[DEBUG curl] ${buildCurlCommand(fetchUrl, fetchInit)}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  if (!resp.ok) {
    const text = await resp.text();
    appLogger.error(`[GraphQL] Workers usage query failed: ${resp.status} ${text}\n[DEBUG curl] ${buildCurlCommand(fetchUrl, fetchInit)}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  const json = await resp.json() as any;
  if (json.errors) {
    appLogger.error(`[GraphQL] Errors: ${JSON.stringify(json.errors)}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  const acct = json?.data?.viewer?.accounts?.[0];
  const workerRecords = acct?.workers || [];
  const pagesRecords = acct?.pages || [];

  let totalRequests = 0, totalErrors = 0, totalSubrequests = 0, totalCpuUs = 0;
  for (const rec of workerRecords) {
    const s = rec.sum || {};
    totalRequests += s.requests || 0;
    totalErrors += s.errors || 0;
    totalSubrequests += s.subrequests || 0;
    totalCpuUs += s.cpuTimeUs || 0;
  }
  for (const rec of pagesRecords) {
    const s = rec.sum || {};
    totalRequests += s.requests || 0;
    totalErrors += s.errors || 0;
  }

  return {
    requests: totalRequests,
    errors: totalErrors,
    subrequests: totalSubrequests,
    cpuTimeMs: Math.round(totalCpuUs / 1000),
  };
}
