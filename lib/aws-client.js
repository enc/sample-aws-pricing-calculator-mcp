// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const SAVE_URL = process.env.AWS_SAVE_URL || 'https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs';
const CDN_BASE = 'https://d1qsjq9pzbk1k6.cloudfront.net';

const PARTITIONS = {
  'aws': {
    manifestPath: '/manifest/en_US.json',
    cdnPrefix: '',
    contract: null,
    awsPartition: 'aws',
    regions: {},
  },
  'aws-iso': {
    manifestPath: '/aws-iso/manifest/en_US.json',
    cdnPrefix: '/aws-iso',
    contract: '5423f8cd3b711c6f899ba4dade31b50c',
    awsPartition: 'aws-iso',
    regions: {
      'us-iso-east-1': 'US ISO East',
      'us-iso-west-1': 'US ISO West',
    },
  },
  'aws-iso-b': {
    manifestPath: '/aws-iso-b/manifest/en_US.json',
    cdnPrefix: '/aws-iso-b',
    contract: '5423f8cd3b711c6f899ba4dade31b50c',
    awsPartition: 'aws-iso-b',
    regions: {
      'us-isob-east-1': 'US ISOB East (Ohio)',
    },
  },
};

const MANIFEST_URL = process.env.AWS_MANIFEST_URL || `${CDN_BASE}${PARTITIONS['aws'].manifestPath}`;

function resolvePartition(region) {
  if (!region) return 'aws';
  if (region.startsWith('us-iso-')) return 'aws-iso';
  if (region.startsWith('us-isob-')) return 'aws-iso-b';
  return 'aws';
}

const manifestCache = new Map();
const definitionCache = new Map();

async function loadManifest(partition = 'aws') {
  if (!PARTITIONS[partition]) {
    throw new Error(`Unknown partition '${partition}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}`);
  }

  if (manifestCache.has(partition)) return manifestCache.get(partition);

  const url = `${CDN_BASE}${PARTITIONS[partition].manifestPath}`;
  const promise = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    const manifest = await res.json();
    const services = new Map();
    manifest.awsServices.forEach(s => {
      const key = s.key || s.serviceCode;
      if (key) services.set(key, { ...s, key });
    });
    console.error(`Loaded ${services.size} services from manifest (partition: ${partition})`);
    return services;
  })();

  manifestCache.set(partition, promise);

  // Allow retry on failure — clear only this partition's cache entry
  promise.catch(() => { manifestCache.delete(partition); });

  return promise;
}

function findService(manifest, name) {
  const lower = name.toLowerCase();
  for (const [key, svc] of manifest) {
    if (key.toLowerCase() === lower) return svc;
  }
  return null;
}

function searchServices(manifest, query) {
  const terms = query.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const search = (term) => {
    const matches = [];
    for (const [key, svc] of manifest) {
      if (svc.subType === 'subServiceSelector') continue;
      if (svc.isActive === 'false') continue;
      const hit = key.toLowerCase().includes(term)
        || (svc.name && svc.name.toLowerCase().includes(term))
        || svc.searchKeywords?.some(kw => kw.toLowerCase().includes(term));
      if (hit) matches.push({ key, name: svc.name });
    }
    return matches;
  };
  if (terms.length === 1) return search(terms[0]);
  const results = {};
  for (const term of terms) results[term] = search(term);
  return results;
}

async function fetchServiceDefinition(manifest, serviceCode, partition = 'aws') {
  const cacheKey = `${partition}:${serviceCode}`;
  if (definitionCache.has(cacheKey)) return definitionCache.get(cacheKey);

  const svc = manifest.get(serviceCode);
  if (!svc) return null;

  const urlPath = svc.serviceDefinitionUrlPath || `/data/${serviceCode}/en_US.json`;
  const cdnPrefix = PARTITIONS[partition]?.cdnPrefix || '';
  const res = await fetch(`${CDN_BASE}${cdnPrefix}${urlPath}`);
  if (!res.ok) throw new Error(`Definition fetch failed for ${serviceCode}: HTTP ${res.status}`);

  const definition = await res.json();
  definitionCache.set(cacheKey, definition);
  return definition;
}

function parseDoubleEncodedResponse(rawText) {
  let result;
  try { result = JSON.parse(rawText); }
  catch { throw new Error('AWS save API returned invalid JSON'); }

  let body;
  try { body = JSON.parse(result.body); }
  catch { throw new Error('AWS save API returned invalid body'); }

  if (!body.savedKey) {
    throw new Error(`AWS save API did not return a savedKey: ${JSON.stringify(body).substring(0, 200)}`);
  }
  return body;
}

async function saveEstimate(payload) {
  const jsonBody = JSON.stringify(payload);
  console.error(`[save] Sending ${jsonBody.length} bytes, ${Object.keys(payload.groups || {}).length} groups, ${Object.keys(payload.services || {}).length} ungrouped services`);
  const res = await fetch(SAVE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Referer': 'https://calculator.aws/' },
    body: jsonBody,
  });
  const rawText = await res.text();
  if (!res.ok) {
    console.error(`[save] HTTP ${res.status}: ${rawText.substring(0, 500)}`);
    let detail;
    try {
      const body = parseDoubleEncodedResponse(rawText);
      detail = body.message || rawText.substring(0, 200);
    } catch {
      detail = rawText.substring(0, 200);
    }
    throw new Error(`AWS save API returned HTTP ${res.status}: ${detail}`);
  }
  const body = parseDoubleEncodedResponse(rawText);
  console.error(`[save] OK → ${body.savedKey}`);
  return {
    estimateId: body.savedKey,
    shareableUrl: `https://calculator.aws/#/estimate?id=${body.savedKey}`,
  };
}

const INPUT_TYPES = new Set([
  'input', 'numericInput', 'frequency', 'fileSize', 'durationInput', 'percentInput',
]);
const INPUT_SUBTYPES = new Set([
  'dropdown', 'numericInput', 'frequency', 'fileSize', 'durationInput',
  'columnFormIPM', 'dataTransferV2',
]);

// Human-readable hint describing the value shape the calculator
// frontend expects for a columnFormIPM composite widget. Exposed to
// agents so they can supply an already-shaped value without guessing.
const COLUMN_FORM_IPM_VALUE_SHAPE =
  'columnFormIPM expects {value: [rowObject]} — an array of one or more row objects. ' +
  'Each row is keyed by the selectorId (or label where no selectorId is defined; ' +
  'the utilization row uses the literal key "undefined"). Every cell wraps its value as ' +
  '{value: ...}. Example for RDS: {value: [{"Number of Nodes": {value: "1"}, ' +
  '"Instance Type": {value: "db.r6g.xlarge"}, "undefined": {value: {unit: "100", ' +
  'selectedId: "%Utilized/Month"}}, "Deployment Option": {value: "Single-AZ"}, ' +
  '"TermType": {value: "OnDemand"}}]}.';

function extractInputFields(definition) {
  const fields = [];
  const seen = new Set();

  const visit = (obj, templateId) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.id && (INPUT_TYPES.has(obj.type) || INPUT_SUBTYPES.has(obj.subType))) {
      const fieldType = obj.subType || obj.type;
      // Skip non-input decorative types
      if (['bodyText', 'headerText', 'alert'].includes(fieldType)) {
        // still walk into children — decorative wrappers may host inputs
      } else if (obj.id.includes('WithoutFreeTier') || obj.id.includes('_withoutFree') || obj.id.endsWith('_MVP')) {
        // Skip "without free tier" / MVP duplicate fields — these are alternate
        // versions of the same inputs for different pricing modes
      } else {
        // Deduplicate across templates by id+type. We still remember the
        // *first* template we found the field in, so agents can tell
        // which template a field belongs to when they are disjoint
        // (e.g. Amazon MQ's ActiveMQ vs RabbitMQ templates).
        const dedupKey = obj.id + ':' + fieldType;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);

          const field = { id: obj.id, type: fieldType };
          if (templateId) field.templateId = templateId;
          if (obj.label) field.label = obj.label;
          if (obj.options) {
            field.options = obj.options
              .filter(o => o.id !== undefined || o.label !== undefined)
              .map(o => {
                const opt = {};
                if (o.id !== undefined) opt.id = o.id;
                if (o.label) opt.label = o.label;
                return opt;
              });
          }
          if (obj.unit) field.unit = obj.unit;
          // fileSize fields: include valid size units and default unit format
          if (fieldType === 'fileSize') {
            const sizes = obj.dropDownSize?.map(s => s.value || s.id) || ['gb'];
            const defaultSize = obj.defaultOption?.size || 'gb';
            const defaultFreq = obj.defaultOption?.frequency || 'NA';
            field.unitFormat = `{value}|{size}|{frequency} — sizes: [${sizes.join(', ')}], default: "${defaultSize}|${defaultFreq}"`;
            field.validSizes = sizes;
            field.defaultUnit = `${defaultSize}|${defaultFreq}`;
          }
          // columnFormIPM composite: expose the row schema so an
          // agent can build the expected value shape without trial
          // and error. The calculator stores this as a matrix keyed
          // by selectorId (or label when no selectorId), with a
          // literal "undefined" key for the utilization row.
          if (fieldType === 'columnFormIPM') {
            field.row = (obj.row || []).map(r => {
              const item = {
                label: r.label,
                selectorId: r.selectorId,
                type: r.type,
              };
              if (r.exportValueAs) item.exportValueAs = r.exportValueAs;
              if (r.isInstanceType) item.isInstanceType = true;
              if (r.mappingValue) item.mappingValue = r.mappingValue;
              return item;
            });
            field.valueShape = COLUMN_FORM_IPM_VALUE_SHAPE;
          }
          fields.push(field);
        }
      }
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) v.forEach(x => visit(x, templateId));
      else if (typeof v === 'object') visit(v, templateId);
    }
  };

  // Walk each template separately so fields can be tagged with their
  // owning template. This lets callers (agents, the estimate builder)
  // tell which template a given field belongs to when a service has
  // more than one (e.g. Amazon MQ → singleInstanceBroker vs
  // rabbitMQBroker).
  const templates = Array.isArray(definition.templates) ? definition.templates : null;
  if (templates && templates.length > 0) {
    for (const tpl of templates) visit(tpl, tpl.id);
  } else {
    visit(definition, null);
  }
  return fields;
}

const READ_URL = 'https://d3knqfixx3sbls.cloudfront.net';

async function fetchEstimate(estimateId) {
  const res = await fetch(`${READ_URL}/${estimateId}`);
  if (!res.ok) throw new Error(`Failed to fetch estimate: HTTP ${res.status}`);
  return res.json();
}

function estimateToMarkdown(data) {
  const lines = [`# ${data.name || 'AWS Estimate'}\n`];
  const total = data.totalCost;
  if (total) lines.push(`**Total Monthly Cost:** $${total.monthly?.toFixed(2) || '0.00'}${total.upfront ? ` | **Upfront:** $${total.upfront.toFixed(2)}` : ''}\n`);

  const renderServices = (services, indent = '') => {
    for (const [, svc] of Object.entries(services)) {
      const cost = svc.serviceCost?.monthly != null ? ` — $${svc.serviceCost.monthly.toFixed(2)}/mo` : '';
      lines.push(`${indent}- **${svc.serviceName}** (${svc.regionName})${cost}`);
      if (svc.description) lines.push(`${indent}  - Description: ${svc.description}`);
      if (svc.configSummary) lines.push(`${indent}  - Config: ${svc.configSummary}`);
    }
  };

  if (data.services && Object.keys(data.services).length > 0) {
    lines.push('## Services\n');
    renderServices(data.services);
  }

  if (data.groups) {
    for (const [, group] of Object.entries(data.groups)) {
      lines.push(`\n## ${group.name || 'Group'}\n`);
      if (group.totalCost?.monthly != null) lines.push(`**Group Monthly:** $${group.totalCost.monthly.toFixed(2)}\n`);
      if (group.services) renderServices(group.services);
    }
  }

  return lines.join('\n');
}

module.exports = { PARTITIONS, resolvePartition, loadManifest, findService, searchServices, fetchServiceDefinition, saveEstimate, extractInputFields, parseDoubleEncodedResponse, fetchEstimate, estimateToMarkdown };
