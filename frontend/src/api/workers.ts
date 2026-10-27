import apiClient from './client';

export interface DeployTarget { accountId: number; workerName: string }
// 环境变量类型：明文 / 机密 / JSON（JSON 仅 Worker 支持，Pages 的 env_vars 无 json 类型）
export type DeployVarType = 'plain_text' | 'secret_text' | 'json';
export interface DeployVarInput { name: string; value: string; secret: boolean; keep?: boolean; type?: DeployVarType }
export interface DeployBindingInput {
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

export const workersApi = {
  // List all (可按 accountId 按需加载，不带参数返回全部)
  getAll: (accountId?: number) => apiClient.get('/workers', {
    params: accountId != null ? { accountId } : undefined,
  }),
  // 账户用量 + 已部署数量摘要
  getSummary: () => apiClient.get('/workers/summary'),

  // Delete
  delete: (accountId: number, name: string) => apiClient.delete(`/workers/${accountId}/workers/${name}`),
  deletePages: (accountId: number, name: string) => apiClient.delete(`/workers/${accountId}/pages/${name}`),
  getLogs: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/logs`, { _silent: true }),

  // Secrets
  getSecrets: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/secrets`),
  updateSecret: (accountId: number, workerName: string, secretName: string, type: string, text?: string, keyBase64?: string) =>
    apiClient.put(`/workers/${accountId}/workers/${workerName}/secrets`, { name: secretName, type, text, key_base64: keyBase64 }),
  deleteSecret: (accountId: number, name: string, secretName: string) =>
    apiClient.delete(`/workers/${accountId}/workers/${name}/secrets/${secretName}`),

  // Schedules (Cron Triggers)
  getSchedules: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/schedules`),
  updateSchedules: (accountId: number, name: string, crons: string[]) =>
    apiClient.put(`/workers/${accountId}/workers/${name}/schedules`, { crons }),

  // Custom Domains
  getDomains: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/domains`),
  createDomain: (accountId: number, name: string, hostname: string, environment?: string) =>
    apiClient.post(`/workers/${accountId}/workers/${name}/domains`, { hostname, environment }),
  deleteDomain: (accountId: number, name: string, domainId: string) =>
    apiClient.delete(`/workers/${accountId}/workers/${name}/domains/${domainId}`),

  // Subdomain (workers.dev)
  getSubdomain: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/subdomain`),
  setSubdomain: (accountId: number, name: string, enabled: boolean) =>
    apiClient.put(`/workers/${accountId}/workers/${name}/subdomain`, { enabled }),

  // Script Settings
  getSettings: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/settings`),
  updateSettings: (accountId: number, name: string, settings: any) =>
    apiClient.patch(`/workers/${accountId}/workers/${name}/settings`, settings),

  // Routes
  getRoutes: (accountId: number, name: string, zoneId: string) =>
    apiClient.get(`/workers/${accountId}/workers/${name}/routes?zone_id=${zoneId}`),
  createRoute: (accountId: number, name: string, zoneId: string, pattern: string, script?: string) =>
    apiClient.post(`/workers/${accountId}/workers/${name}/routes`, { zone_id: zoneId, pattern, script }),
  deleteRoute: (accountId: number, name: string, routeId: string, zoneId: string) =>
    apiClient.delete(`/workers/${accountId}/workers/${name}/routes/${routeId}?zone_id=${zoneId}`),

  // Script Content
  getContent: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/content`, { _silent: true }),

  // Deployments
  getDeployments: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/deployments`),

  // Pages Settings
  getPagesProject: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/pages/${name}/project`),
  editPagesProject: (accountId: number, name: string, params: any) => apiClient.patch(`/workers/${accountId}/pages/${name}/project`, params),
  getPagesDomains: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/pages/${name}/domains`),
  addPagesDomain: (accountId: number, name: string, hostname: string) => apiClient.post(`/workers/${accountId}/pages/${name}/domains`, { hostname }),
  removePagesDomain: (accountId: number, name: string, hostname: string) => apiClient.delete(`/workers/${accountId}/pages/${name}/domains/${hostname}`),
  getPagesDeployments: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/pages/${name}/deployments`),
  deletePagesDeployments: (accountId: number, name: string, ids: string[]) =>
    apiClient.delete(`/workers/${accountId}/pages/${name}/deployments`, { data: { ids } }),

  // Resources (for Pages bindings)
  getKvNamespaces: (accountId: number) => apiClient.get(`/workers/${accountId}/resources/kv`),
  getD1Databases: (accountId: number) => apiClient.get(`/workers/${accountId}/resources/d1`),
  getR2Buckets: (accountId: number, config?: any) => apiClient.get(`/workers/${accountId}/resources/r2`, config),
  getZones: (accountId: number) => apiClient.get(`/workers/${accountId}/resources/zones`, { timeout: 60000 }),
  updatePagesBindings: (accountId: number, name: string, deploymentConfigs: any) =>
    apiClient.put(`/workers/${accountId}/pages/${name}/bindings`, { deployment_configs: deploymentConfigs }),

  // Usage
  getUsage: () => apiClient.get('/workers/usage'),

  // Batch Deploy (单账户 = targets 长度 1)
  batchDeploy: (targets: DeployTarget[], opts: { script?: File; url?: string; assets?: File; mainModule?: string; vars?: DeployVarInput[]; bindings?: DeployBindingInput[]; isRedeploy?: boolean } = {}) => {
    const formData = new FormData();
    formData.append('targets', JSON.stringify(targets));
    if (opts.script) formData.append('script', opts.script);
    if (opts.url) formData.append('url', opts.url);
    if (opts.assets) formData.append('assets', opts.assets);
    if (opts.mainModule) formData.append('mainModule', opts.mainModule);
    if (opts.vars?.length) formData.append('vars', JSON.stringify(opts.vars));
    if (opts.bindings?.length) formData.append('bindings', JSON.stringify(opts.bindings));
    if (opts.isRedeploy) formData.append('isRedeploy', 'true');
    return apiClient.post('/workers/batch-deploy', formData, { timeout: 120000 });
  },
  batchDeployPages: (targets: DeployTarget[], opts: { zipFile?: File; vars?: DeployVarInput[]; bindings?: DeployBindingInput[]; isRedeploy?: boolean } = {}) => {
    const formData = new FormData();
    formData.append('targets', JSON.stringify(targets));
    if (opts.zipFile) formData.append('zipFile', opts.zipFile);
    if (opts.vars?.length) formData.append('vars', JSON.stringify(opts.vars));
    if (opts.bindings?.length) formData.append('bindings', JSON.stringify(opts.bindings));
    if (opts.isRedeploy) formData.append('isRedeploy', 'true');
    return apiClient.post('/workers/batch-deploy-pages', formData, { timeout: 300000 });
  },

  // Config (重部署预填)
  getWorkerConfig: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/config`),
  getPagesConfig: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/pages/${name}/config`),

  // Environment Sync
  envSyncPreview: (source: { accountId: number; workerName: string }, targets: Array<{ accountId: number; workerName: string }>, syncTypes?: string[]) =>
    apiClient.post('/workers/env-sync/preview', { source, targets, syncTypes }),
  envSyncExecute: (source: { accountId: number; workerName: string }, targets: Array<{ accountId: number; workerName: string }>, secretValues: Record<string, string>, syncTypes?: string[]) =>
    apiClient.post('/workers/env-sync/execute', { source, targets, secretValues, syncTypes }),
};
