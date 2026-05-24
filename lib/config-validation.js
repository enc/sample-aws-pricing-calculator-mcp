// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const { loadManifest, findService, fetchServiceDefinition, extractInputFields, enrichFieldsWithMetadata } = require('./aws-client');

const META_KEYS = new Set(['region', 'description']);

const EC2_FIELDS = new Set([
  'region',
  'description',
  'quantity',
  'instanceType',
  'selectedOS',
  'tenancy',
  'pricingStrategy',
  'storageType',
  'storageAmount',
  'snapshotFrequency',
  'gp3Iops',
  'gp3Throughput',
  'iops',
  'iops2',
  'storageAmountIo2',
  'dataTransferForEC2',
  'utilization',
]);

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = d[0];
    d[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = d[i];
      d[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, d[i], d[i - 1]);
      prev = tmp;
    }
  }
  return d[m];
}

function suggestMatch(invalid, validIds, max = 3) {
  const lower = invalid.toLowerCase();
  return validIds
    .map(id => ({ id, dist: levenshtein(lower, id.toLowerCase()) }))
    .filter(m => m.dist <= Math.max(Math.floor(invalid.length * 0.6), 3))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max)
    .map(m => m.id);
}

function isNumericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return value.trim() !== '' && Number.isFinite(Number(value));
}

function unwrapValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.value !== undefined) {
    return value.value;
  }
  return value;
}

function validateMeasuredValue(field, value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`  "${field.id}" must be an object with "value" and "unit".`);
    return;
  }
  if (!isNumericValue(value.value)) {
    errors.push(`  "${field.id}.value" must be numeric.`);
  }
  if (typeof value.unit !== 'string' || value.unit.trim() === '') {
    errors.push(`  "${field.id}.unit" is required.`);
    return;
  }
  if (field.type === 'fileSize' && field.validSizes) {
    const [size] = value.unit.split('|');
    if (!field.validSizes.includes(size)) {
      errors.push(`  "${field.id}.unit" uses size "${size}". Allowed sizes: ${field.validSizes.join(', ')}.`);
    }
  }
}

function validateColumnForm(field, value, errors) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.value)) {
    errors.push(`  "${field.id}" must be { "value": [rowObject] }.`);
    return;
  }

  const allowedKeys = new Set((field.row || []).map(r => r.selectorId || r.label || 'undefined'));
  if ((field.row || []).some(r => !r.selectorId)) allowedKeys.add('undefined');

  for (const [idx, row] of value.value.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`  "${field.id}.value[${idx}]" must be an object.`);
      continue;
    }
    for (const key of Object.keys(row)) {
      if (allowedKeys.size > 0 && !allowedKeys.has(key)) {
        errors.push(`  "${field.id}.value[${idx}].${key}" is not in the row schema.`);
      }
    }
    for (const [selectorId, allowedValues] of Object.entries(field.selectorValues || {})) {
      const cell = row[selectorId];
      if (!cell || !allowedValues || allowedValues.length === 0) continue;
      const cellValue = unwrapValue(cell);
      if (typeof cellValue !== 'string') continue;
      if (!allowedValues.includes(cellValue)) {
        const suggestions = suggestMatch(cellValue, allowedValues);
        const hint = suggestions.length
          ? ` Did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?`
          : '';
        errors.push(`  "${field.id}" selector "${selectorId}" value "${cellValue}" is not valid.${hint}`);
      }
    }
  }
}

function validateAgainstFields(serviceKey, config, fields) {
  const errors = [];
  const fieldById = new Map(fields.map(f => [f.id, f]));
  const validIds = fields.map(f => f.id);
  const configKeys = Object.keys(config).filter(k => !META_KEYS.has(k));
  const invalid = configKeys.filter(k => !fieldById.has(k));

  if (invalid.length > 0) {
    const lines = invalid.map(k => {
      const suggestions = suggestMatch(k, validIds);
      return suggestions.length
        ? `  "${k}" - did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?`
        : `  "${k}" - no close match found`;
    });
    errors.push(`Invalid field IDs for ${serviceKey}:\n${lines.join('\n')}\nUse get_service_config_schema to discover valid field IDs.`);
  }

  for (const key of configKeys) {
    const field = fieldById.get(key);
    if (!field) continue;
    const value = config[key];
    const raw = unwrapValue(value);
    if (raw == null || raw === '') continue;

    if (field.type === 'numericInput' || field.type === 'percentInput') {
      if (!isNumericValue(raw)) errors.push(`  "${field.id}" must be numeric.`);
    } else if (field.type === 'frequency' || field.type === 'durationInput' || field.type === 'fileSize') {
      validateMeasuredValue(field, value, errors);
    } else if (field.type === 'dropdown' && Array.isArray(field.options) && field.options.length > 0) {
      const ids = field.options.map(o => o.id).filter(id => id !== undefined);
      if (ids.length > 0 && !ids.includes(raw)) {
        const suggestions = suggestMatch(String(raw), ids);
        const hint = suggestions.length
          ? ` Did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?`
          : '';
        errors.push(`  "${field.id}" value "${raw}" is not a valid option.${hint}`);
      }
    } else if (field.type === 'columnFormIPM') {
      validateColumnForm(field, value, errors);
    }
  }

  return errors;
}

function validateEc2Config(config) {
  const errors = [];
  for (const key of Object.keys(config)) {
    if (!EC2_FIELDS.has(key)) errors.push(`  "${key}" is not a supported EC2 config field.`);
  }
  for (const key of ['quantity', 'snapshotFrequency', 'gp3Iops', 'gp3Throughput', 'iops', 'iops2', 'utilization']) {
    if (config[key] != null && !isNumericValue(unwrapValue(config[key]))) {
      errors.push(`  "${key}" must be numeric.`);
    }
  }
  for (const key of ['storageAmount', 'storageAmountIo2']) {
    if (config[key] != null && typeof config[key] === 'object') {
      validateMeasuredValue({ id: key, type: 'fileSize', validSizes: ['gb', 'tb', 'mb'] }, config[key], errors);
    } else if (config[key] != null && !isNumericValue(config[key])) {
      errors.push(`  "${key}" must be numeric or a {value, unit} object.`);
    }
  }
  return errors;
}

async function validateServiceConfig(serviceKey, config, partition) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'Config must be an object.';
  }
  if (!config.region || typeof config.region !== 'string') {
    return 'Missing required "region" in config. Ask the user for the AWS region and include it explicitly.';
  }

  if (serviceKey.toLowerCase() === 'ec2enhancement') {
    const errors = validateEc2Config(config);
    return errors.length ? `Invalid EC2 config:\n${errors.join('\n')}` : null;
  }

  const configKeys = Object.keys(config).filter(k => !META_KEYS.has(k));
  if (configKeys.length === 0) return null;

  try {
    const manifest = await loadManifest(partition || 'aws');
    const svc = findService(manifest, serviceKey);
    if (!svc) return null;

    const def = await fetchServiceDefinition(manifest, svc.key, partition || 'aws');
    if (!def) return null;

    const fields = await enrichFieldsWithMetadata(def, extractInputFields(def));
    const errors = validateAgainstFields(svc.key, config, fields);
    return errors.length ? errors.join('\n') : null;
  } catch {
    return null;
  }
}

module.exports = {
  validateServiceConfig,
  validateAgainstFields,
  validateEc2Config,
  suggestMatch,
  levenshtein,
};
