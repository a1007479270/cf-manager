import { describe, it, expect } from 'vitest';
import { buildMultipartBody, createWorkerUploadForm } from '../src/services/deploy/uploadForm';
import type { CfWorkerInit } from '../src/services/deploy/types';

/**
 * 上传 multipart 序列化回归。
 *
 * 背景：proxyFetch 配置代理后改用 node-fetch 发送，而 node-fetch 无法序列化
 * Node 内置 FormData、也不会补 Content-Type，CF 直接返回 415（不开代理走
 * undici 故不复现）。因此全仓统一改为手动拼 Buffer + 显式 Content-Type。
 *
 * 这里用手工固定的 boundary 与 undici 原生 FormData 的输出做逐字节比对，
 * 确保重构 createWorkerUploadForm（改走 buildMultipartBody）没有改变既有报文。
 */

/**
 * 用 undici 原生 FormData 生成基准报文（测试运行在 Node 18+）。
 * 注意：undici 对「无 filename 的 Blob」会自动补 filename="blob"，
 * 而本实现刻意不补——CF 按 part 的 name 识别字段，已上线的 createWorkerUploadForm
 * 一直如此且工作正常。故逐字节比对只覆盖带 filename 的 part。
 */
async function undiciBaseline(
  parts: Array<{ name: string; value: string | Buffer; filename?: string; type?: string }>,
): Promise<Buffer> {
  const fd = new FormData();
  for (const p of parts) {
    const blob = new Blob([p.value], p.type ? { type: p.type } : undefined);
    fd.append(p.name, blob, p.filename);
  }
  const buf = Buffer.from(await new Response(fd).arrayBuffer());
  const text = buf.toString('latin1');
  const realBoundary = /----formdata-undici-([^\s]+)/.exec(text)?.[1];
  expect(realBoundary, 'undici boundary 应可解析').toBeTruthy();
  return Buffer.from(text.split(`----formdata-undici-${realBoundary}`).join(FIXED), 'latin1');
}

const FIXED = 'BOUNDARY';

describe('buildMultipartBody：multipart 序列化', () => {
  it('单个文件 part：结构为 --b / 头 / 空行 / 内容 / 结束边界', () => {
    const { body, contentType } = buildMultipartBody(
      [{ name: 'worker.js', value: 'console.log(1)', filename: 'worker.js', contentType: 'application/javascript+module' }],
      FIXED,
    );
    expect(contentType).toBe(`multipart/form-data; boundary=${FIXED}`);
    expect(body.toString('utf-8')).toBe(
      `--${FIXED}\r\n` +
      'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n' +
      'Content-Type: application/javascript+module\r\n' +
      '\r\n' +
      'console.log(1)\r\n' +
      `--${FIXED}--\r\n`,
    );
  });

  it('字符串字段不写 Content-Type（对齐 undici）', () => {
    const { body } = buildMultipartBody([{ name: 'manifest', value: '{"a":1}' }], FIXED);
    const text = body.toString('utf-8');
    expect(text).toContain('Content-Disposition: form-data; name="manifest"\r\n\r\n{"a":1}');
    expect(text).not.toContain('Content-Type');
  });

  it('文件字段缺 MIME 时回退 octet-stream', () => {
    const { body } = buildMultipartBody([{ name: '_routes.json', value: '{}', filename: '_routes.json' }], FIXED);
    expect(body.toString('utf-8')).toContain('Content-Type: application/octet-stream');
  });

  it('part 名与文件名中的引号被转义，防止破坏头部', () => {
    const { body } = buildMultipartBody([{ name: 'a"b', value: 'x', filename: 'c"d' }], FIXED);
    const text = body.toString('utf-8');
    expect(text).toContain('name="a%22b"; filename="c%22d"');
  });

  it('二进制内容按原始字节拼入，Buffer.concat 后长度自洽', () => {
    const bin = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80]);
    const { body } = buildMultipartBody([{ name: 'f', value: bin, filename: 'f.bin', contentType: 'application/octet-stream' }], FIXED);
    expect(body.includes(bin)).toBe(true);
    // 头部 + 内容 + 尾部，总长可确定（不会因视图共享底层内存而漂移）
    const headerLen = Buffer.byteLength(`--${FIXED}\r\nContent-Disposition: form-data; name="f"; filename="f.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tailLen = Buffer.byteLength(`\r\n--${FIXED}--\r\n`);
    expect(body.length).toBe(headerLen + bin.length + tailLen);
  });

  it('带 filename 的多 part 与 undici 原生 FormData 输出逐字节一致', async () => {
    const parts = [
      { name: 'worker.js', value: 'export default { fetch(){} }', filename: 'worker.js', type: 'application/javascript+module' },
      { name: 'blob.bin', value: Buffer.from([1, 2, 3, 250]), filename: 'blob.bin', type: 'application/octet-stream' },
    ];
    const mine = buildMultipartBody(
      parts.map(p => ({ name: p.name, value: p.value, filename: p.filename, contentType: p.type })),
      FIXED,
    );
    const baseline = await undiciBaseline(parts);
    expect(mine.body.toString('latin1')).toBe(baseline.toString('latin1'));
  });

  it('metadata 等无 filename 字段不补 filename（CF 按 name 识别，对齐 createWorkerUploadForm）', () => {
    const { body } = buildMultipartBody([{ name: 'metadata', value: '{}', contentType: 'application/json' }], FIXED);
    expect(body.toString('utf-8')).toContain('Content-Disposition: form-data; name="metadata"\r\n');
    expect(body.toString('utf-8')).not.toContain('filename');
  });
});

describe('createWorkerUploadForm：Worker 脚本上传表单', () => {
  const baseWorker: CfWorkerInit = {
    main: { name: 'worker.js', type: 'esm', content: 'export default {}' },
    modules: [],
    sourceMaps: [],
    compatibility_date: '2024-11-01',
  } as unknown as CfWorkerInit;

  it('metadata + 主模块 + 附加模块 + sourcemap 结构完整', () => {
    const worker = {
      ...baseWorker,
      modules: [{ name: 'util.js', type: 'esm', content: 'export const a=1' }],
      sourceMaps: [{ name: 'worker.js.map', content: '{"version":3}' }],
      assets: { jwt: 'JWT', config: { html_handling: 'auto-trailing-slash' } },
    } as unknown as CfWorkerInit;

    const { body, contentType } = createWorkerUploadForm(worker, [{ name: 'KV', type: 'kv_namespace', namespace_id: 'n1' }]);
    const text = body.toString('utf-8');

    expect(contentType.startsWith('multipart/form-data; boundary=----formdata-cf-manager-')).toBe(true);
    // metadata part 带 application/json
    expect(text).toContain('Content-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n');
    // metadata 内容含 assets.jwt 与 bindings
    expect(text).toContain('"jwt":"JWT"');
    expect(text).toContain('"namespace_id":"n1"');
    // 主模块 / 附加模块 / sourcemap 各一个 part，且带 filename
    expect(text).toContain('name="worker.js"; filename="worker.js"');
    expect(text).toContain('name="util.js"; filename="util.js"');
    expect(text).toContain('name="worker.js.map"; filename="worker.js.map"');
    // 结束边界
    const boundary = contentType.split('boundary=')[1];
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  });

  it('compatibility_flags 为空数组时不发送', () => {
    const { body } = createWorkerUploadForm({ ...baseWorker, compatibility_flags: [] } as unknown as CfWorkerInit, undefined);
    expect(body.toString('utf-8')).not.toContain('compatibility_flags');
  });
});
