import { Account } from '../models/account';
import { getCfClient, getAuthHeaders } from './cfFactory';
import { proxyFetch } from './proxyService';
import { resolveVarType, normalizeJsonText } from './bindings';
import type { ManualVarInput, VarType } from './bindings';
import { getScriptContent, deployWorker, updateSecret, deleteSecret } from './workerService';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

export interface WorkerConfigBinding {
  type: string;
  name: string;
  mode: 'existing';
  resourceName?: string;
  className?: string;
  scriptName?: string;
  service?: string;
  environment?: string;
  queueName?: string;
}

export interface WorkerConfigVar {
  name: string;
  value: string | null;
  secret: boolean;
  // 变量类型：plain_text / secret_text / json（JSON 值以格式化文本回显，便于直接编辑）
  type: VarType;
}

export interface WorkerConfigResult {
  vars: WorkerConfigVar[];
  bindings: WorkerConfigBinding[];
}

export async function getWorkerConfig(account: Account, name: string): Promise<WorkerConfigResult> {
  const authHeaders = getAuthHeaders(account);
  const resp = await proxyFetch(`${CF_BASE}/accounts/${account.account_id}/workers/scripts/${name}`, { headers: authHeaders }, 30000, undefined, account);
  const buf = Buffer.from(await resp.arrayBuffer());
  const contentType = (resp.headers.get('content-type') || '') as string;
  const vars: WorkerConfigVar[] = [];
  const bindings: WorkerConfigBinding[] = [];

  const mapBinding = (b: any) => {
    if (b.type === 'plain_text') vars.push({ name: b.name, value: b.text ?? '', secret: false, type: 'plain_text' });
    else if (b.type === 'secret_text') vars.push({ name: b.name, value: null, secret: true, type: 'secret_text' });
    // CF 的 json binding 把值放在 json 字段里（对象/数组/数字…），回显为格式化文本供编辑
    else if (b.type === 'json') vars.push({ name: b.name, value: JSON.stringify(b.json ?? null, null, 2), secret: false, type: 'json' });
    else {
      // 归一化为前端意图类型，并保留高级绑定的参数字段供重部署预填回填
      const intentType =
        b.type === 'durable_object_namespace' ? 'durable_object' :
        b.type === 'kv_namespace' ? 'kv' :
        b.type === 'r2_bucket' ? 'r2' : b.type;
      bindings.push({
        type: intentType, name: b.name, mode: 'existing',
        resourceName: b.namespace_id || b.id || b.bucket_name || undefined,
        ...(intentType === 'durable_object' ? { className: b.class_name, scriptName: b.script_name } : {}),
        ...(intentType === 'service' ? { service: b.service, environment: b.environment } : {}),
        ...(intentType === 'queue' ? { queueName: b.queue_name } : {}),
      });
    }
  };

  // 1) multipart metadata part（非版本化 worker 的 GET /scripts/:name 返回 bindings）
  if (/multipart\/form-data/i.test(contentType)) {
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
    if (boundary) {
      const delim = Buffer.from(`--${boundary}`);
      const findIndex = (hay: Buffer, needle: Buffer, from = 0): number => {
        outer: for (let i = from; i <= hay.length - needle.length; i++) {
          for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
          return i;
        }
        return -1;
      };
      let pos = findIndex(buf, delim);
      while (pos >= 0 && pos < buf.length) {
        const next = findIndex(buf, delim, pos + delim.length);
        const seg = next < 0 ? buf.subarray(pos + delim.length) : buf.subarray(pos + delim.length, next);
        if (seg.length > 0) {
          const headerEnd = findIndex(seg, Buffer.from('\r\n\r\n'));
          if (headerEnd >= 0 && /name="metadata"/i.test(seg.subarray(0, headerEnd).toString())) {
            let body = seg.subarray(headerEnd + 4);
            if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) body = body.subarray(0, body.length - 2);
            try {
              const meta = JSON.parse(body.toString());
              for (const b of (meta.bindings || [])) mapBinding(b);
            } catch { /* metadata 解析失败忽略，走版本化 fallback */ }
          }
        }
        if (next < 0) break;
        pos = next;
      }
    }
  }

  // 2) 版本化 fallback：版本化 worker 的 GET /scripts/:name 不返回 bindings，
  //    必须查 Versions API（当前部署版本的 resources.bindings）
  if (vars.length === 0 && bindings.length === 0) {
    try {
      const cf = getCfClient(account);
      const deps: any = await cf.workers.scripts.deployments.list(name, { account_id: account.account_id! });
      const latest = (deps?.deployments || deps?.result?.deployments || [])[0];
      const vid = latest?.versions?.[0]?.version_id;
      if (vid) {
        const v: any = await cf.workers.scripts.versions.get(name, vid, { account_id: account.account_id! });
        const raw = (v?.resources?.bindings || v?.result?.resources?.bindings || []) as any[];
        for (const b of raw) mapBinding(b);
      }
    } catch { /* 读回失败静默，前端有降级提示 */ }
  }

  return { vars, bindings };
}

export async function getPagesConfig(account: Account, name: string): Promise<WorkerConfigResult> {
  const cf = getCfClient(account);
  const project = await cf.pages.projects.get(name, { account_id: account.account_id! });
  const cfg = project?.deployment_configs?.production || {};
  const vars: WorkerConfigVar[] = [];
  const bindings: WorkerConfigBinding[] = [];
  for (const [k, v] of Object.entries<any>(cfg.env_vars || {})) {
    const isSecret = v?.type === 'secret_text';
    vars.push({ name: k, value: isSecret ? null : (v?.value ?? ''), secret: isSecret, type: isSecret ? 'secret_text' : 'plain_text' });
  }
  for (const [name, v] of Object.entries<any>(cfg.kv_namespaces || {})) bindings.push({ type: 'kv', name, resourceName: v?.namespace_id, mode: 'existing' });
  for (const [name, v] of Object.entries<any>(cfg.d1_databases || {})) bindings.push({ type: 'd1', name, resourceName: v?.id, mode: 'existing' });
  for (const [name, v] of Object.entries<any>(cfg.r2_buckets || {})) bindings.push({ type: 'r2', name, resourceName: v?.name, mode: 'existing' });
  if ((cfg as any).ai?.binding) bindings.push({ type: 'ai', name: (cfg as any).ai.binding, mode: 'existing' });
  return { vars, bindings };
}

// 全量覆盖 + diff：
// - plain/资源绑定有变化 → 用 scriptContent（或拉取现有代码）重传 deployWorker
// - 仅 secrets 变化 → 只调 updateSecret/deleteSecret，不重传代码
export async function applyWorkerConfigDiff(
  account: Account,
  name: string,
  opts: { vars: ManualVarInput[]; bindings: Record<string, unknown>[]; scriptContent?: string; packageZip?: Buffer; mainModule?: string },
): Promise<void> {
  const current = await getWorkerConfig(account, name);
  // 非 secret 变量（明文 / JSON）指纹：类型与规范化值都比，JSON 忽略缩进差异
  const varsFingerprint = (vars: Array<{ name: string; value?: string | null; secret?: boolean; type?: string }>) => {
    const out = new Map<string, string>();
    for (const v of vars || []) {
      const type = resolveVarType(v);
      if (type === 'secret_text' || !v.name) continue;
      out.set(v.name, `${type}|${type === 'json' ? normalizeJsonText(v.value || '') : (v.value || '')}`);
    }
    return out;
  };
  const secretNames = (vars: Array<{ name: string; secret?: boolean; type?: string }>) =>
    new Set((vars || []).filter(v => resolveVarType(v) === 'secret_text').map(v => v.name));
  const currentPlain = varsFingerprint(current.vars);
  const currentSecretNames = secretNames(current.vars);
  const targetPlain = varsFingerprint(opts.vars || []);
  const targetSecretNames = secretNames(opts.vars || []);

  const plainChanged = targetPlain.size !== currentPlain.size
    || [...targetPlain.entries()].some(([k, val]) => currentPlain.get(k) !== val);
  // 指纹只比较（类型:名称）集合——current.bindings 不含资源 id，opts.bindings 含 id，比较语义集合即可
  // secret 由 secrets API 独立管理：剔除 secret_text，避免新增/修改 secret 误触发代码重传
  // 写入侧为 CF 原始类型（kv_namespace 等），比较前统一归一化为前端意图类型（与读取侧 getWorkerConfig 一致）
  const toIntentType = (type: string) =>
    type === 'durable_object_namespace' ? 'durable_object' :
    type === 'kv_namespace' ? 'kv' :
    type === 'r2_bucket' ? 'r2' : type;
  const bindingFingerprint = (arr: any[]) => JSON.stringify((arr || []).filter((b: any) => b.type !== 'secret_text').map((b: any) => `${toIntentType(b.type)}:${b.name}`).sort());
  const bindingsChanged = bindingFingerprint(opts.bindings) !== bindingFingerprint(current.bindings);
  console.log(`[DBG] applyWorkerConfigDiff name=${name} vars=${JSON.stringify((opts.vars || []).map((v: any) => `${v.name}:${resolveVarType(v)}${v.keep ? '(keep)' : ''}`))} plainChanged=${plainChanged} bindingsChanged=${bindingsChanged}`);

  // 删除：现有 secret 不在目标集合
  for (const s of currentSecretNames) {
    if (!targetSecretNames.has(s)) {
      try { await deleteSecret(account, name, s); } catch { /* 删除失败不阻塞 */ }
    }
  }

  if (plainChanged || bindingsChanged) {
    let content: string | Buffer;
    if (opts.scriptContent !== undefined && opts.scriptContent !== null) content = opts.scriptContent;
    else if (opts.packageZip) content = '';
    else content = await getScriptContent(account, name); // 复用现有代码
    console.log(`[DBG] redeploy content type=${typeof content} length=${Buffer.isBuffer(content) ? content.length : (content as string).length}`);
    await deployWorker(account, name, content, {
      bindings: opts.bindings,
      // 版本化 worker 下 PUT 只创建版本不部署，必须显式创建 deployment 才会上线（否则重部署的 vars/bindings 不生效）
      createDeployment: true,
      ...(opts.packageZip ? { packageZip: opts.packageZip, mainModule: opts.mainModule } : {}),
    });
    const after = await getWorkerConfig(account, name);
    console.log(`[DBG] redeploy after vars=${JSON.stringify(after.vars)} bindings=${JSON.stringify(after.bindings)}`);
  }

  // 新增/更新 secrets（keep=true 或值为空则跳过）
  for (const v of opts.vars || []) {
    if (resolveVarType(v) !== 'secret_text' || !v.name || v.keep) continue;
    if (v.value) await updateSecret(account, name, v.name, 'secret_text', v.value);
  }
}
