import { Account } from '../models/account';
import { getCfClient } from './cfFactory';

// 环境变量类型：明文 / 机密 / JSON（对应 CF bindings 的 plain_text / secret_text / json）
export type VarType = 'plain_text' | 'secret_text' | 'json';
export interface ManualVarInput { name: string; value: string; secret: boolean; keep?: boolean; type?: VarType }
export interface ManualBindingInput {
  type: 'kv' | 'd1' | 'r2' | 'ai' | 'durable_object' | 'service' | 'queue';
  name: string;
  resourceName?: string;
  mode?: 'auto' | 'existing';
  existingId?: string;
  className?: string;
  scriptName?: string;
  service?: string;
  environment?: string;
  queueName?: string;
}

// 校验绑定名：CF binding name 必须以字母开头，仅含 A-Z0-9_，全大写惯例
export function isValidBindingName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

// 兼容两种入参写法：显式 type 优先，其次由 secret 布尔推导（旧前端只传 secret）
export function resolveVarType(v: { secret?: boolean; type?: string }): VarType {
  if (v.type === 'json') return 'json';
  if (v.type === 'secret_text' || v.secret) return 'secret_text';
  return 'plain_text';
}

// JSON 变量的值在 UI 里以文本编辑，写入 CF 时必须转成真正的 JSON 值（对象/数组/数字/字符串…）
export function parseJsonVarValue(name: string, raw: string): unknown {
  const text = (raw ?? '').trim();
  if (!text) throw new Error(`JSON 变量 ${name} 的值不能为空`);
  try {
    return JSON.parse(text);
  } catch (e: any) {
    throw new Error(`JSON 变量 ${name} 不是合法的 JSON：${e?.message || e}`, { cause: e });
  }
}

// 规范化 JSON 文本：仅用于 diff 比较，忽略缩进 / 空行 / 键顺序以外的格式差异
export function normalizeJsonText(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

export function varsToBindings(vars: ManualVarInput[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const v of vars || []) {
    if (!v.name || !isValidBindingName(v.name)) continue;
    const type = resolveVarType(v);
    // keep 的 secret：值不可读（CF 不回显），留空保持原值——不生成 binding，
    // 由 applyWorkerConfigDiff 的 secrets API 保持，避免空值覆盖现有 secret
    if (type === 'secret_text' && v.keep) continue;
    if (type === 'json') {
      // CF 的 json binding 直接承载 JSON 值，而不是字符串
      out.push({ type: 'json', name: v.name, json: parseJsonVarValue(v.name, v.value) });
      continue;
    }
    out.push(type === 'secret_text'
      ? { type: 'secret_text', name: v.name, text: v.value }
      : { type: 'plain_text', name: v.name, text: v.value });
  }
  return out;
}

// 复用 deploy/index.ts 的按名解析模式：查重 → 复用 / 创建（不依赖模板）。
// account 已含 cf account_id 与 API 凭据（getCfClient 内部处理）。
export async function resolveManualBindings(account: Account, inputs: ManualBindingInput[]): Promise<Record<string, unknown>[]> {
  const cf = getCfClient(account);
  const accountId = account.account_id!;
  const out: Record<string, unknown>[] = [];
  for (const b of inputs || []) {
    if (!b.name || !isValidBindingName(b.name)) throw new Error(`非法绑定名: ${b.name || '(空)'}`);
    switch (b.type) {
      case 'kv': {
        if (b.mode === 'existing') {
          if (!b.existingId) throw new Error(`KV 绑定 ${b.name} 缺少 existingId`);
          out.push({ type: 'kv_namespace', name: b.name, namespace_id: b.existingId });
          break;
        }
        if (!b.resourceName) throw new Error(`KV 绑定 ${b.name} 缺少资源名`);
        const kvItems: any[] = [];
        for await (const ns of cf.kv.namespaces.list({ account_id: accountId })) kvItems.push(ns);
        const found = kvItems.find((n: any) => n.title === b.resourceName);
        const ns = found || (await cf.kv.namespaces.create({ account_id: accountId, title: b.resourceName }));
        out.push({ type: 'kv_namespace', name: b.name, namespace_id: ns.id });
        break;
      }
      case 'd1': {
        if (b.mode === 'existing') {
          if (!b.existingId) throw new Error(`D1 绑定 ${b.name} 缺少 existingId`);
          out.push({ type: 'd1', name: b.name, id: b.existingId });
          break;
        }
        if (!b.resourceName) throw new Error(`D1 绑定 ${b.name} 缺少资源名`);
        const d1Items: any[] = [];
        for await (const db of cf.d1.database.list({ account_id: accountId })) d1Items.push(db);
        const found = d1Items.find((d: any) => d.name === b.resourceName);
        const db = found || (await cf.d1.database.create({ account_id: accountId, name: b.resourceName }));
        out.push({ type: 'd1', name: b.name, id: db.uuid });
        break;
      }
      case 'r2': {
        if (b.mode === 'existing') {
          if (!b.existingId) throw new Error(`R2 绑定 ${b.name} 缺少 existingId`);
          out.push({ type: 'r2_bucket', name: b.name, bucket_name: b.existingId });
          break;
        }
        if (!b.resourceName) throw new Error(`R2 绑定 ${b.name} 缺少资源名`);
        const r2Resp: any = await cf.r2.buckets.list({ account_id: accountId });
        const found = (r2Resp?.buckets || []).find((bk: any) => bk.name === b.resourceName);
        const bucket = found || (await cf.r2.buckets.create({ account_id: accountId, name: b.resourceName }));
        out.push({ type: 'r2_bucket', name: b.name, bucket_name: bucket.name });
        break;
      }
      case 'ai':
        out.push({ type: 'ai', name: b.name });
        break;
      case 'durable_object':
        if (!b.className) throw new Error(`DO 绑定 ${b.name} 缺少类名`);
        out.push({ type: 'durable_object_namespace', name: b.name, class_name: b.className, script_name: b.scriptName || undefined });
        break;
      case 'service':
        if (!b.service) throw new Error(`Service 绑定 ${b.name} 缺少目标服务名`);
        out.push({ type: 'service', name: b.name, service: b.service, environment: b.environment || 'production' });
        break;
      case 'queue':
        if (!b.queueName) throw new Error(`Queue 绑定 ${b.name} 缺少队列名`);
        out.push({ type: 'queue', name: b.name, queue_name: b.queueName });
        break;
    }
  }
  return out;
}

// 对齐 deploy/index.ts buildPagesDeploymentConfigs 的字段格式（wrangler 源码确认）：
// kv_namespaces/d1_databases/r2_buckets 是对象 map，不是数组。
export function buildPagesConfigsFromInput(vars: ManualVarInput[], resolved: Record<string, unknown>[]): { production: any; preview: any } | undefined {
  const prod: any = { compatibility_date: '2024-11-01' };
  const prev: any = { compatibility_date: '2024-11-01' };
  for (const v of vars || []) {
    if (!v.name || !isValidBindingName(v.name)) continue;
    const type = resolveVarType(v);
    // keep 的 secret：值不可读（CF 不回显），留空保持原值——不写入 env_vars
    if (type === 'secret_text' && v.keep) continue;
    if (!prod.env_vars) { prod.env_vars = {}; prev.env_vars = {}; }
    // Pages 的 env_vars 只接受 plain_text / secret_text：JSON 变量以紧凑序列化字符串写入，
    // Functions 里读到的是字符串，需自行 JSON.parse（Worker 端才是原生 json binding）。
    const value = type === 'json' ? JSON.stringify(parseJsonVarValue(v.name, v.value)) : v.value;
    const cfType = type === 'secret_text' ? 'secret_text' : 'plain_text';
    prod.env_vars[v.name] = { value, type: cfType };
    prev.env_vars[v.name] = { value, type: cfType };
  }
  for (const b of resolved as Array<Record<string, any>>) {
    switch (b.type) {
      case 'kv_namespace': {
        if (!prod.kv_namespaces) { prod.kv_namespaces = {}; prev.kv_namespaces = {}; }
        prod.kv_namespaces[b.name] = { namespace_id: (b as any).namespace_id };
        prev.kv_namespaces[b.name] = { namespace_id: (b as any).namespace_id };
        break;
      }
      case 'd1': {
        if (!prod.d1_databases) { prod.d1_databases = {}; prev.d1_databases = {}; }
        prod.d1_databases[b.name] = { id: (b as any).id };
        prev.d1_databases[b.name] = { id: (b as any).id };
        break;
      }
      case 'r2_bucket': {
        if (!prod.r2_buckets) { prod.r2_buckets = {}; prev.r2_buckets = {}; }
        prod.r2_buckets[b.name] = { name: (b as any).bucket_name };
        prev.r2_buckets[b.name] = { name: (b as any).bucket_name };
        break;
      }
      case 'ai': {
        prod.ai = { binding: b.name };
        prev.ai = { binding: b.name };
        break;
      }
    }
  }
  const hasConfigs = Object.keys(prod).length > 1; // 排除仅 compatibility_date
  return hasConfigs ? { production: prod, preview: prev } : undefined;
}
