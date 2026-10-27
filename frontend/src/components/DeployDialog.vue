<template>
  <n-modal v-model:show="visible" preset="card" :title="isRedeploy ? t('workers.deployDialog.redeployTitle', { name: redeploy?.name }) : t('workers.deployDialog.title')" style="width: 760px; max-width: 95vw">
    <n-form label-placement="top" size="small">
      <!-- 顶部固定区 -->
      <n-grid :cols="2" :x-gap="12">
        <n-form-item-gi :label="t('workers.deployDialog.deployTypeLabel')">
          <n-radio-group v-model:value="deployType" :disabled="isRedeploy">
            <n-radio value="worker">Worker</n-radio><n-radio value="pages">Pages</n-radio>
          </n-radio-group>
        </n-form-item-gi>
        <n-form-item-gi :label="t('workers.deployDialog.targetAccounts')">
          <n-select v-model:value="targetAccountIds" :options="accountOptions" :render-label="renderAccountLabel" multiple filterable :disabled="isRedeploy" :placeholder="t('workers.deployDialog.targetAccountsPlaceholder')" />
          <template v-if="r2MixedCount" #feedback>
            <n-text type="warning" depth="3" style="font-size: 12px">
              {{ t('workers.deployDialog.r2MixedHint', { count: r2MixedCount }) }}
            </n-text>
          </template>
        </n-form-item-gi>
      </n-grid>
      <n-form-item :label="t('workers.deployDialog.nameLabel')">
        <n-input v-model:value="name" :disabled="isRedeploy" :placeholder="deployType === 'pages' ? t('workers.deployDialog.pagesNamePlaceholder') : t('workers.deployDialog.workerNamePlaceholder')" />
      </n-form-item>
      <!-- 代码来源：新建显示；重部署隐藏 + 更换代码展开 -->
      <n-form-item v-if="!isRedeploy" :label="t('workers.deployDialog.codeSourceLabel')">
        <n-space vertical style="width: 100%">
          <n-radio-group v-model:value="source">
            <n-radio value="file">{{ t('workers.deployDialog.fileOption') }}</n-radio>
            <!-- Pages 仅支持 zip 上传，无 URL 代码源 -->
            <n-radio v-if="deployType === 'worker'" value="url">URL</n-radio>
          </n-radio-group>
          <n-upload v-if="source === 'file'" :max="1" :default-upload="false" @change="onScriptChange" :accept="deployType === 'pages' ? '.zip' : '.js,.zip'">
            <n-button size="small">{{ deployType === 'pages' ? t('workers.deployDialog.selectZip') : t('workers.deployDialog.selectJsZip') }}</n-button>
          </n-upload>
          <n-input v-else v-model:value="scriptUrl" placeholder="https://example.com/worker.js" />
        </n-space>
      </n-form-item>
      <n-form-item v-else>
        <n-collapse>
          <n-collapse-item :title="t('workers.deployDialog.changeCode')" name="code">
            <n-upload :max="1" :default-upload="false" @change="onScriptChange" :accept="deployType === 'pages' ? '.zip' : '.js,.zip'">
              <n-button size="small">{{ deployType === 'pages' ? t('workers.deployDialog.selectZip') : t('workers.deployDialog.selectJsZip') }}</n-button>
            </n-upload>
          </n-collapse-item>
        </n-collapse>
      </n-form-item>

      <!-- tab 配置区 -->
      <n-tabs type="line" :value="activeTab" @update:value="activeTab = $event">
        <n-tab-pane name="vars" :tab="t('workers.deployDialog.tabVars')">
          <DeployEnvVarsTab v-model="vars" :allow-json="deployType === 'worker'" />
        </n-tab-pane>
        <n-tab-pane name="kv" :tab="t('workers.deployDialog.tabKv')">
          <DeployResourceTab v-model="kvRows" resource-type="kv" :account-ids="targetAccountIds" />
        </n-tab-pane>
        <n-tab-pane name="d1" :tab="t('workers.deployDialog.tabD1')">
          <DeployResourceTab v-model="d1Rows" resource-type="d1" :account-ids="targetAccountIds" />
        </n-tab-pane>
        <n-tab-pane v-if="showR2Tab" name="r2" :tab="t('workers.deployDialog.tabR2')">
          <DeployResourceTab v-model="r2Rows" resource-type="r2" :account-ids="targetAccountIds" />
        </n-tab-pane>
        <n-tab-pane name="advanced" :tab="t('workers.deployDialog.tabAdvanced')">
          <DeployAdvancedTab v-model="advancedRows" v-model:ai-enabled="aiEnabled" :is-pages="deployType === 'pages'" />
        </n-tab-pane>
      </n-tabs>

      <!-- 结果区 -->
      <template v-if="results.length">
        <n-divider>{{ t('workers.deployDialog.resultTitle') }}</n-divider>
        <n-spin v-if="deploying" style="display:block; text-align:center; padding: 8px">{{ t('workers.deployDialog.deploying') }}</n-spin>
        <n-space v-for="r in results" :key="`r-${r.accountId}`" align="center" :size="6" style="margin: 4px 0">
          <n-tag :type="r.success ? 'success' : 'error'" size="small" :bordered="false">{{ r.success ? t('workers.deployDialog.successTag') : t('workers.deployDialog.failTag') }}</n-tag>
          <n-text style="font-size: 13px">{{ r.accountName || t('workers.deployDialog.accountFallback', { id: r.accountId }) }}</n-text>
          <n-text v-if="!r.success" type="error" depth="3" style="font-size: 12px; flex: 1">{{ r.error }}</n-text>
          <n-button v-if="!r.success" size="tiny" type="primary" ghost :loading="r.retrying" @click="retryAccount(r)">{{ t('workers.deployDialog.retry') }}</n-button>
        </n-space>
      </template>
    </n-form>

    <template #footer>
      <n-space justify="end" :size="8">
        <n-button @click="visible = false">{{ t('workers.deployDialog.closeBtn') }}</n-button>
        <n-button type="primary" :loading="deploying" :disabled="!canDeploy" @click="handleDeploy">{{ t('workers.deployDialog.deployBtn') }}</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch, h } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMessage, NTag } from 'naive-ui';
import { workersApi } from '../api/workers';
import type { DeployTarget, DeployVarInput, DeployBindingInput } from '../api/workers';
import { useWorkerStore } from '../stores/workerStore';
import { hasR2Feature } from '../utils/r2Feature'; // Task 10 Step 3 创建
import DeployEnvVarsTab from './DeployEnvVarsTab.vue';
import DeployResourceTab from './DeployResourceTab.vue';
import DeployAdvancedTab from './DeployAdvancedTab.vue';

const { t } = useI18n();
const props = defineProps<{ show: boolean; redeploy?: { type: 'worker' | 'pages'; name: string; accountId: number } | null; allAccounts: any[] }>();
const emit = defineEmits<{ 'update:show': [boolean]; deployed: [any] }>();
const message = useMessage();
const workerStore = useWorkerStore();

const visible = computed({ get: () => props.show, set: (v) => emit('update:show', v) });
const isRedeploy = ref(false); // 由 watch 根据 props.redeploy 设置
const deployType = ref<'worker' | 'pages'>('worker');
const targetAccountIds = ref<number[]>([]);
const name = ref('');
const source = ref<'file' | 'url'>('file');
const scriptFile = ref<File | null>(null);
const scriptUrl = ref('');
const deploying = ref(false);
const activeTab = ref('vars');
const vars = ref<DeployVarInput[]>([]);
const kvRows = ref<DeployBindingInput[]>([]);
const d1Rows = ref<DeployBindingInput[]>([]);
const r2Rows = ref<DeployBindingInput[]>([]);
const advancedRows = ref<DeployBindingInput[]>([]);
const aiEnabled = ref(false);
const results = ref<Array<{ accountId: number; accountName?: string; success: boolean; error?: string; retrying?: boolean }>>([]);

const accountOptions = computed(() =>
  props.allAccounts.filter(a => a.is_active && (a.enabled_features || '').includes('workers')).map(a => ({ label: a.name, value: a.id }))
);
const selectedAccounts = computed(() => props.allAccounts.filter(a => targetAccountIds.value.includes(a.id)));
// 未开通 R2 的选中账户数（>0 时隐藏 R2 tab 并提示）
const r2MixedCount = computed(() => selectedAccounts.value.filter(a => !hasR2Feature(a)).length);
const showR2Tab = computed(() => selectedAccounts.value.length > 0 && r2MixedCount.value === 0);

function renderAccountLabel(option: any) {
  const acc = props.allAccounts.find((a: any) => a.id === option.value);
  return h('span', { style: 'display: inline-flex; align-items: center; gap: 4px' }, [
    option.label,
    acc && hasR2Feature(acc) ? h(NTag, { size: 'tiny', type: 'success', bordered: false }, { default: () => 'R2' }) : null,
  ]);
}

const allBindings = computed<DeployBindingInput[]>(() => {
  const rows = [...kvRows.value, ...d1Rows.value, ...r2Rows.value, ...advancedRows.value];
  return aiEnabled.value ? [...rows, { type: 'ai', name: 'AI' }] : rows;
});
const canDeploy = computed(() => targetAccountIds.value.length > 0 && name.value.trim() !== '' && (isRedeploy.value || !!scriptFile.value || (source.value === 'url' && !!scriptUrl.value)));

function onScriptChange({ file }: any) { scriptFile.value = file.file || null; }

async function loadConfigForRedeploy() {
  const acc = props.redeploy?.accountId;
  const n = props.redeploy?.name;
  if (!acc || !n) return;
  try {
    const { data } = props.redeploy?.type === 'pages'
      ? await workersApi.getPagesConfig(acc, n)
      : await workersApi.getWorkerConfig(acc, n);
    vars.value = (data.vars || []).map((v: any) => ({
      name: v.name,
      value: v.value ?? '',
      secret: v.secret,
      // 保留变量类型（JSON 变量回显的是格式化后的 JSON 文本）
      type: v.type || (v.secret ? 'secret_text' : 'plain_text'),
      keep: v.secret && !v.value,
    }));
    kvRows.value = (data.bindings || []).filter((b: any) => b.type === 'kv' || b.type === 'kv_namespace').map((b: any) => ({ type: 'kv', name: b.name, mode: b.resourceName ? 'existing' : 'auto', existingId: b.resourceName }));
    d1Rows.value = (data.bindings || []).filter((b: any) => b.type === 'd1').map((b: any) => ({ type: 'd1', name: b.name, mode: b.resourceName ? 'existing' : 'auto', existingId: b.resourceName }));
    r2Rows.value = (data.bindings || []).filter((b: any) => b.type === 'r2' || b.type === 'r2_bucket').map((b: any) => ({ type: 'r2', name: b.name, mode: b.resourceName ? 'existing' : 'auto', existingId: b.resourceName }));
    // ai 绑定由 aiEnabled 开关表达，不进 advancedRows（避免 allBindings 重复）
    advancedRows.value = (data.bindings || []).filter((b: any) => ['durable_object', 'service', 'queue'].includes(b.type)).map((b: any) => ({ ...b, mode: 'existing' }));
    aiEnabled.value = (data.bindings || []).some((b: any) => b.type === 'ai');
  } catch (e: any) {
    message.warning(t('workers.deployDialog.configReadFailed', { error: e?.errorMessage || e?.message || t('common.unknown') }));
    // 保持重部署模式，配置区留空供手动填写；不做"降级为新建"（账户/名称仍锁定）
  }
}

// 修复 keep 残留：用户编辑 secret 值时重置 keep（否则 keep 残留导致
// applyWorkerConfigDiff 的 secrets 循环跳过 PUT，secret 永远不更新）
watch(vars, (newVars) => {
  for (const r of newVars || []) {
    if (r.secret && r.keep && r.value) r.keep = false;
  }
}, { deep: true });

async function handleDeploy() {
  const targets: DeployTarget[] = targetAccountIds.value.map(accountId => ({ accountId, workerName: name.value.trim() }));
  deploying.value = true;
  results.value = [];
  try {
    const opts: any = { vars: vars.value, bindings: allBindings.value, isRedeploy: isRedeploy.value };
    if (deployType.value === 'worker') {
      if (scriptFile.value) opts.script = scriptFile.value;
      else if (source.value === 'url') opts.url = scriptUrl.value;
      const { data } = await workersApi.batchDeploy(targets, opts);
      results.value = Array.isArray(data) ? data.map((r: any) => ({ ...r, accountName: props.allAccounts.find((a: any) => a.id === r.accountId)?.name })) : [];
    } else {
      if (scriptFile.value) opts.zipFile = scriptFile.value;
      const { data } = await workersApi.batchDeployPages(targets, opts);
      results.value = Array.isArray(data) ? data.map((r: any) => ({ ...r, accountName: props.allAccounts.find((a: any) => a.id === r.accountId)?.name })) : [];
    }
    const successCount = results.value.filter(r => r.success).length;
    if (successCount === results.value.length && results.value.length > 0) {
      message.success(t('workers.deployDialog.allSuccess', { success: successCount, total: results.value.length }));
      emit('deployed', { success: true, results: results.value });
      visible.value = false;
      refresh();
    } else {
      message.warning(t('workers.deployDialog.partialFail', { success: successCount, failed: results.value.length - successCount }));
    }
  } catch (e: any) {
    message.error(t('workers.deployDialog.deployFailed', { error: e?.errorMessage || e?.message || t('common.unknown') }));
  } finally { deploying.value = false; }
}

async function retryAccount(r: any) {
  r.retrying = true;
  try {
    const opts: any = { vars: vars.value, bindings: allBindings.value, isRedeploy: isRedeploy.value };
    if (scriptFile.value) {
      if (deployType.value === 'worker') {
        opts.script = scriptFile.value;
      } else {
        opts.zipFile = scriptFile.value;
      }
    }
    const target = [{ accountId: r.accountId, workerName: name.value.trim() }];
    const { data } = deployType.value === 'worker'
      ? await workersApi.batchDeploy(target, opts)
      : await workersApi.batchDeployPages(target, opts);
    const res = (Array.isArray(data) ? data : [])[0];
    if (res) { r.success = res.success; r.error = res.error; }
    if (res?.success) message.success(t('workers.deployDialog.retrySuccess', { name: r.accountName || t('workers.deployDialog.accountFallback', { id: r.accountId }) }));
  } catch (e: any) {
    r.error = e?.errorMessage || e?.message || t('workers.deployDialog.retryFailed');
  } finally { r.retrying = false; }
}

function refresh() {
  if (workerStore.selectedAccountId) workerStore.fetchWorkers(workerStore.selectedAccountId);
  else workerStore.fetchWorkers();
  workerStore.fetchSummary();
}

watch(() => props.show, (s) => {
  if (!s) return;
  isRedeploy.value = !!props.redeploy;
  if (props.redeploy) {
    deployType.value = props.redeploy.type;
    targetAccountIds.value = [props.redeploy.accountId];
    name.value = props.redeploy.name;
    loadConfigForRedeploy();
  } else {
    source.value = 'file'; // Pages 模式无 URL 代码源，恢复默认
    deployType.value = 'worker';
    targetAccountIds.value = [];
    name.value = '';
    vars.value = []; kvRows.value = []; d1Rows.value = []; r2Rows.value = []; advancedRows.value = [];
    aiEnabled.value = false; results.value = []; scriptFile.value = null; scriptUrl.value = ''; source.value = 'file';
  }
  activeTab.value = 'vars';
});

// Pages 仅支持 zip 代码源：切换到 Pages 时若处于 URL 模式则恢复为文件模式
watch(deployType, (val) => {
  if (val === 'pages' && source.value === 'url') source.value = 'file';
  // Pages 的 env_vars 只有明文/机密两种类型：切到 Pages 时把 JSON 变量降级为明文（JSON 文本）
  if (val === 'pages') {
    for (const r of vars.value) {
      if (r.type === 'json') { r.type = 'plain_text'; r.secret = false; }
    }
  }
});
</script>
