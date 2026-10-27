import { Account } from '../db/models';
import { cfFetch, cfFetchRaw } from './cfApi';
import { deployWorker } from './assetsDeploy';
import { resolveVarType, normalizeJsonText } from './bindings';
import type { ManualVarInput, VarType } from './bindings';

export interface WorkerConfigVar {
  name: string;
  value: string | null;
  secret: boolean;
  // 变量类型：plain_text / secret_text / json（JSON 值以格式化文本回显，便于直接编辑）
  type: VarType;
}

export interface WorkerConfig {
  vars: WorkerConfigVar[];
  bindings: Array<{ type: string; name: string; resourceName?: string; mode: 'existing'; className?: string; scriptName?: string; service?: string; environment?: string; queueName?: string }>;
}

// 提取 multipart 中 name="metadata" 的 part（content 端点解析 worker.js 的对称实现）
function extractMetadataPart(buf: Uint8Array, contentType: string): any | null {
  if (!/multipart\/form-data/i.test(contentType)) return null;
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) return null;
  const delim = new TextEncoder().encode(`--${boundary}`);
  const findIndex = (hay: Uint8Array, needle: Uint8Array, from = 0): number => {
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
      const headerEnd = findIndex(seg, new TextEncoder().encode('\r\n\r\n'));
      if (headerEnd >= 0 && /name="metadata"/i.test(new TextDecoder().decode(seg.subarray(0, headerEnd)))) {
        let body = seg.subarray(headerEnd + 4);
        if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) body = body.subarray(0, body.length - 2);
        try { return JSON.parse(new TextDecoder().decode(body)); } catch { return null; }
      }
    }
    if (next < 0) break;
    pos = next;
  }
  return null;
}

export async function getWorkerConfig(account: Account, encryptionKey: string, name: string): Promise<WorkerConfig> {
  const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/workers/scripts/${name}`, encryptionKey);
  const buf = new Uint8Array(await resp.arrayBuffer());
  const meta = extractMetadataPart(buf, resp.headers.get('content-type') || '');
  const vars: WorkerConfig['vars'] = [];
  const bindings: WorkerConfig['bindings'] = [];
  for (const b of (meta?.bindings || [])) {
    if (b.type === 'plain_text') vars.push({ name: b.name, value: b.text ?? '', secret: false, type: 'plain_text' });
    else if (b.type === 'secret_text') vars.push({ name: b.name, value: null, secret: true, type: 'secret_text' });
    // CF 的 json binding 把值放在 json 字段里（对象/数组/数字…），回显为格式化文本供编辑
    else if (b.type === 'json') vars.push({ name: b.name, value: JSON.stringify(b.json ?? null, null, 2), secret: false, type: 'json' });
    else {
      // 归一化为前端意图类型，并保留高级绑定的参数字段供重部署预填回填（与 backend 对称）
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
  }
  return { vars, bindings };
}

export async function getPagesConfig(account: Account, encryptionKey: string, name: string): Promise<WorkerConfig> {
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/pages/projects/${name}`, encryptionKey);
  const cfg = data?.result?.deployment_configs?.production || {};
  const vars: WorkerConfig['vars'] = [];
  const bindings: WorkerConfig['bindings'] = [];
  for (const [k, v] of Object.entries<any>(cfg.env_vars || {})) {
    const isSecret = v?.type === 'secret_text';
    vars.push({ name: k, value: isSecret ? null : (v?.value ?? ''), secret: isSecret, type: isSecret ? 'secret_text' : 'plain_text' });
  }
  for (const [bName, v] of Object.entries<any>(cfg.kv_namespaces || {})) bindings.push({ type: 'kv', name: bName, resourceName: v?.namespace_id, mode: 'existing' });
  for (const [bName, v] of Object.entries<any>(cfg.d1_databases || {})) bindings.push({ type: 'd1', name: bName, resourceName: v?.id, mode: 'existing' });
  for (const [bName, v] of Object.entries<any>(cfg.r2_buckets || {})) bindings.push({ type: 'r2', name: bName, resourceName: v?.name, mode: 'existing' });
  if (cfg.ai?.binding) bindings.push({ type: 'ai', name: cfg.ai.binding, mode: 'existing' });
  return { vars, bindings };
}

// 拉取现有代码（GET script → 提取 worker.js part，逻辑与 worker routes content 端点一致）
async function getScriptContent(account: Account, encryptionKey: string, name: string): Promise<string> {
  const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/workers/scripts/${name}`, encryptionKey);
  const buf = new Uint8Array(await resp.arrayBuffer());
  const contentType = resp.headers.get('content-type') || '';
  if (!/multipart\/form-data/i.test(contentType)) return new TextDecoder().decode(buf);
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) return new TextDecoder().decode(buf);
  const delim = new TextEncoder().encode(`--${boundary}`);
  const findIndex = (hay: Uint8Array, needle: Uint8Array, from = 0): number => {
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
      const headerEnd = findIndex(seg, new TextEncoder().encode('\r\n\r\n'));
      if (headerEnd >= 0 && /name="worker\.js"/i.test(new TextDecoder().decode(seg.subarray(0, headerEnd)))) {
        let body = seg.subarray(headerEnd + 4);
        if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) body = body.subarray(0, body.length - 2);
        return new TextDecoder().decode(body);
      }
    }
    if (next < 0) break;
    pos = next;
  }
  return new TextDecoder().decode(buf);
}

export async function applyWorkerConfigDiff(
  account: Account,
  encryptionKey: string,
  name: string,
  opts: { vars: ManualVarInput[]; bindings: Record<string, unknown>[]; scriptContent?: string },
): Promise<void> {
  const current = await getWorkerConfig(account, encryptionKey, name);
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
  // secret 由 secrets API 独立管理：剔除 secret_text，避免新增/修改 secret 误触发代码重传
  // 写入侧为 CF 原始类型（kv_namespace 等），比较前统一归一化为前端意图类型（与读取侧 getWorkerConfig 一致）
  const toIntentType = (type: string) =>
    type === 'durable_object_namespace' ? 'durable_object' :
    type === 'kv_namespace' ? 'kv' :
    type === 'r2_bucket' ? 'r2' : type;
  const bindingFingerprint = (arr: any[]) => JSON.stringify((arr || []).filter((b: any) => b.type !== 'secret_text').map((b: any) => `${toIntentType(b.type)}:${b.name}`).sort());
  const bindingsChanged = bindingFingerprint(opts.bindings) !== bindingFingerprint(current.bindings);

  for (const s of currentSecretNames) {
    if (!targetSecretNames.has(s)) {
      try {
        await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${name}/secrets/${encodeURIComponent(s)}`, encryptionKey, { method: 'DELETE' });
      } catch { /* 删除失败不阻塞 */ }
    }
  }

  if (plainChanged || bindingsChanged) {
    const content = opts.scriptContent !== undefined && opts.scriptContent !== null
      ? opts.scriptContent
      : await getScriptContent(account, encryptionKey, name);
    await deployWorker(account, encryptionKey, name, new TextEncoder().encode(content), { bindings: opts.bindings });
  }

  for (const v of opts.vars || []) {
    if (resolveVarType(v) !== 'secret_text' || !v.name || v.keep) continue;
    if (v.value) {
      await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${name}/secrets`, encryptionKey, {
        method: 'PUT', body: JSON.stringify({ name: v.name, type: 'secret_text', text: v.value }),
      });
    }
  }
}
