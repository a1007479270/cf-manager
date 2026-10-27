import type { CfWorkerInit, CfModuleType } from './types';

// 模块类型 → MIME 映射（对齐 wrangler moduleTypeMimeType）
const MODULE_MIME: Record<CfModuleType, string> = {
  'esm': 'application/javascript+module',
  'commonjs': 'application/javascript',
  'compiled-wasm': 'application/wasm',
  'text': 'text/plain',
  'buffer': 'application/octet-stream',
};

export interface MultipartBody {
  body: Buffer;
  contentType: string;
}

/** multipart 中的单个 part */
export interface MultipartPart {
  name: string;
  value: string | Uint8Array | Buffer;
  /** 有 filename 时写入 filename=，CF 据此把该 part 识别为文件 */
  filename?: string;
  /** MIME 类型。字符串字段（无 filename）不写 Content-Type，对齐 undici */
  contentType?: string;
}

// 将 string / Uint8Array / Buffer 安全转换为独立 Buffer（拷贝，不共享底层内存）
function toBuffer(content: string | Uint8Array | Buffer): Buffer {
  if (typeof content === 'string') return Buffer.from(content, 'utf-8');
  // 必须拷贝，避免 Buffer/Uint8Array 视图共享底层 ArrayBuffer 导致 content-length 不匹配
  const copy = Buffer.alloc(content.byteLength);
  copy.set(content);
  return copy;
}

function generateBoundary(): string {
  return '----formdata-cf-manager-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// part 名/文件名中的引号与换行需转义（对齐 undici / wrangler）
function escapeName(name: string): string {
  return name.replace(/"/g, '%22').replace(/\r?\n/g, '');
}

/**
 * 通用 multipart/form-data 手动构建器。
 *
 * 全仓统一走这里而非 new FormData()：proxyFetch 配置代理后改用 node-fetch 发送请求，
 * 而 node-fetch 无法序列化 Node 内置 FormData、也不会自动补 `Content-Type`，
 * Cloudflare 会直接返回 415（不配置代理时走 undici 故不复现）。
 * 手动拼 Buffer + 显式 Content-Type 后，每个 part 字节可控，Content-Length 完全确定。
 */
export function buildMultipartBody(parts: MultipartPart[], boundary?: string): MultipartBody {
  const bnd = boundary || generateBoundary();
  const CRLF = '\r\n';
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${bnd}${CRLF}`));
    const filename = part.filename ? `; filename="${escapeName(part.filename)}"` : '';
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeName(part.name)}"${filename}${CRLF}`));
    // 字符串字段不写 Content-Type（对齐 undici）；文件字段缺 MIME 时按 octet-stream
    if (part.filename || part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType || 'application/octet-stream'}${CRLF}`));
    }
    chunks.push(Buffer.from(CRLF));
    chunks.push(toBuffer(part.value));
    chunks.push(Buffer.from(CRLF));
  }

  chunks.push(Buffer.from(`--${bnd}--${CRLF}`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${bnd}` };
}

/**
 * 手动构建 Worker 脚本上传的 multipart/form-data body。
 *
 * 不使用 FormData + undici 自动序列化，因为 undici 在计算 multipart Content-Length 时
 * 可能与实际 body 不一致（尤其当 Blob 部分由 ArrayBuffer 支撑时），
 * 导致 Cloudflare API 返回截断响应 → UND_ERR_RES_CONTENT_LENGTH_MISMATCH。
 * 走代理时 node-fetch 更无法序列化 FormData（CF 返回 415）。
 *
 * 手动构建可精确控制每个 part 的字节，Buffer.concat 后 Content-Length 完全确定。
 */
export function createWorkerUploadForm(
  worker: CfWorkerInit,
  bindings: Record<string, unknown>[] | undefined,
): MultipartBody {
  // 1. 构建 metadata
  const metadataBindings = bindings || [];
  const metadata: Record<string, unknown> = {
    main_module: worker.main.name,
    compatibility_date: worker.compatibility_date,
    bindings: metadataBindings,
  };
  // 仅在非空时发送 compatibility_flags（对标 wrangler：空数组不发送）
  if (worker.compatibility_flags?.length) metadata.compatibility_flags = worker.compatibility_flags;

  if (worker.migrations?.length) metadata.migrations = worker.migrations;
  if (worker.keepVars) metadata.keep_vars = true;
  if (worker.keepSecrets) metadata.keep_secrets = true;
  // keep_bindings: CF API 期望 []string（要保留的绑定类型列表），不是 boolean
  if (worker.keepBindings) {
    metadata.keep_bindings = [
      'kv_namespace', 'd1', 'r2_bucket',
      'service', 'queue', 'durable_object_namespace',
      'ai', 'assets', 'secret_text', 'plain_text',
    ];
  }
  if (worker.placement) metadata.placement = worker.placement;
  if (worker.tail_consumers?.length) metadata.tail_consumers = worker.tail_consumers;
  if (worker.limits) metadata.limits = worker.limits;
  if (worker.logpush !== undefined) metadata.logpush = worker.logpush;
  if (worker.assets) metadata.assets = worker.assets;
  if (worker.observability) metadata.observability = worker.observability;

  // 2. 组装 parts：metadata + 主模块 + 附加模块 + source maps
  const parts: MultipartPart[] = [
    { name: 'metadata', value: JSON.stringify(metadata), contentType: 'application/json' },
    { name: worker.main.name, value: worker.main.content, filename: worker.main.name, contentType: MODULE_MIME[worker.main.type] },
  ];

  for (const mod of worker.modules) {
    parts.push({ name: mod.name, value: mod.content, filename: mod.name, contentType: MODULE_MIME[mod.type] });
  }

  for (const sm of worker.sourceMaps) {
    parts.push({ name: sm.name, value: sm.content, filename: sm.name, contentType: 'application/json' });
  }

  return buildMultipartBody(parts);
}
