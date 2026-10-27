<template>
  <div>
    <div v-for="(row, idx) in props.modelValue" :key="idx" class="env-var-block">
      <div class="env-var-row">
        <n-input v-model:value="row.name" :placeholder="t('workers.envVars.namePlaceholder')" style="width: 180px" />
        <n-select
          :value="rowType(row)"
          :options="typeOptions"
          size="small"
          style="width: 110px"
          @update:value="(v: DeployVarType) => setRowType(row, v)"
        />
        <n-input
          v-model:value="row.value"
          :type="rowType(row) === 'secret_text' ? 'password' : 'text'"
          :autosize="rowType(row) === 'json' ? { minRows: 2, maxRows: 8 } : undefined"
          :placeholder="placeholderFor(row)"
          style="flex: 1; min-width: 160px"
        />
        <n-button size="tiny" quaternary type="error" @click="removeRow(idx)">{{ t('common.delete') }}</n-button>
      </div>
      <div v-if="rowType(row) === 'json' && jsonError(row.value)" class="env-var-error">
        {{ jsonError(row.value) }}
      </div>
    </div>
    <n-button size="tiny" dashed @click="addRow">{{ t('workers.envVars.add') }}</n-button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DeployVarInput, DeployVarType } from '../api/workers';

const { t } = useI18n();
// allowJson：只有 Workers 的 bindings 支持原生 json 类型，Pages 的 env_vars 只能是明文/机密字符串
const props = defineProps<{ modelValue: DeployVarInput[]; allowJson?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [DeployVarInput[]] }>();

const typeOptions = computed(() => {
  const options: Array<{ label: string; value: DeployVarType }> = [
    { label: t('workers.envVars.plainLabel'), value: 'plain_text' },
    { label: t('workers.envVars.secretLabel'), value: 'secret_text' },
  ];
  if (props.allowJson) options.push({ label: t('workers.envVars.jsonLabel'), value: 'json' });
  return options;
});

// 兼容只有 secret 布尔的历史数据
function rowType(row: DeployVarInput): DeployVarType {
  if (row.type === 'json') return 'json';
  if (row.type === 'secret_text' || row.secret) return 'secret_text';
  return 'plain_text';
}

function setRowType(row: DeployVarInput, type: DeployVarType) {
  row.type = type;
  row.secret = type === 'secret_text';
  // keep 只对机密有意义，切换类型后不应残留
  if (type !== 'secret_text') row.keep = false;
}

function placeholderFor(row: DeployVarInput): string {
  const type = rowType(row);
  if (type === 'json') return t('workers.envVars.jsonPlaceholder');
  if (type === 'secret_text') {
    return row.keep ? t('workers.envVars.keepPlaceholder') : t('workers.envVars.secretValuePlaceholder');
  }
  return t('workers.envVars.valuePlaceholder');
}

function jsonError(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return t('workers.envVars.jsonRequired');
  try {
    JSON.parse(text);
    return '';
  } catch (e: any) {
    return t('workers.envVars.jsonInvalid', { error: e?.message || '' });
  }
}

function addRow() {
  emit('update:modelValue', [...props.modelValue, { name: '', value: '', secret: false, type: 'plain_text' }]);
}
function removeRow(idx: number) {
  const next = props.modelValue.filter((_, i) => i !== idx);
  emit('update:modelValue', next);
}
</script>

<style scoped>
.env-var-block {
  margin-bottom: 8px;
}

.env-var-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  flex-wrap: wrap;
}

.env-var-error {
  margin-top: 4px;
  font-size: 12px;
  color: var(--theme-error);
}
</style>
