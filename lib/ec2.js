// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Amazon EC2 config transformation: converts agent-friendly eC2Next fields
// to the ec2Enhancement format the calculator frontend expects.

const SHORTHAND_RE = /^(?:ri|reserved|convertible|instanceSavings|computeSavings|ondemand)(?:(\d)yr)?(?:(No|Partial|All)Upfront)?$/i;

const MODEL_ALIASES = {
  ri: 'reserved', reserved: 'reserved', convertible: 'convertible',
  instancesavings: 'instanceSavings', computesavings: 'computeSavings', ondemand: 'ondemand',
};

const SELECTED_OPTION = {
  ondemand: 'on-demand', reserved: 'standard', convertible: 'convertible',
  instanceSavings: 'instance-savings', computeSavings: 'compute-savings', spot: 'spot',
};

const PAYMENT_ALIASES = { No: 'None', Partial: 'Partial', All: 'All' };

const EMPTY_DATA_TRANSFER = { value: [
  { entryType: 'INBOUND', value: '', unit: 'tb_month', fromRegion: '' },
  { entryType: 'OUTBOUND', value: '', unit: 'tb_month', toRegion: '' },
  { entryType: 'INTRA_REGION', value: '', unit: 'tb_month' },
]};

function parsePricing(input) {
  if (typeof input === 'string') return parseString(input);
  const obj = (input.value?.model) ? input.value : input;
  return normalize(obj.model || 'ondemand', obj.term || '1yr', obj.upfrontPayment || obj.options || 'None');
}

function parseString(str) {
  const m = str.match(SHORTHAND_RE);
  if (m) {
    const modelKey = str.match(/^[a-zA-Z]+/)[0].toLowerCase();
    return {
      model: MODEL_ALIASES[modelKey] || modelKey,
      term: m[1] ? `${m[1]}yr` : '1yr',
      upfrontPayment: m[2] ? (PAYMENT_ALIASES[m[2]] || m[2]) : 'None',
    };
  }
  const lower = str.toLowerCase();
  let model = 'ondemand';
  if (/instance.savings/i.test(lower)) model = 'instanceSavings';
  else if (/compute.savings/i.test(lower)) model = 'computeSavings';
  else if (lower.includes('convertible')) model = 'convertible';
  else if (lower.includes('reserved') || / ri\b/.test(lower)) model = 'reserved';
  else if (lower.includes('spot')) model = 'spot';

  const termMatch = lower.match(/(\d)\s*(?:yr|year)/);
  let upfrontPayment = 'None';
  if (lower.includes('all upfront')) upfrontPayment = 'All';
  else if (lower.includes('partial')) upfrontPayment = 'Partial';

  return { model, term: termMatch ? `${termMatch[1]}yr` : '1yr', upfrontPayment };
}

function normalize(model, term, payment) {
  payment = payment.replace(/Upfront$/i, '');
  if (payment === 'No') payment = 'None';
  return { model, term, upfrontPayment: payment };
}

function buildPricingStrategy(parsed, utilization, tenancy) {
  let { model, term, upfrontPayment } = parsed;
  const termStr = term === '3yr' ? '3 Year' : '1 Year';

  // Standard/Convertible RIs are only for dedicated/host tenancy
  if (!tenancy || tenancy === 'shared') {
    if (model === 'reserved') model = 'instanceSavings';
    if (model === 'convertible') model = 'computeSavings';
  }

  const selectedOption = SELECTED_OPTION[model] || 'on-demand';
  if (model === 'ondemand') {
    return { value: { selectedOption: 'on-demand', term: termStr, utilizationValue: utilization || '100', utilizationUnit: '%Utilized/Month' } };
  }
  return { value: { selectedOption, term: termStr, upfrontPayment, model } };
}

function transformConfig(config) {
  const tenancy = config.tenancy || 'shared';
  const pricing = parsePricing(config.pricingStrategy || 'ondemand');
  const utilization = config.utilization ? String(config.utilization) : '100';

  return {
    tenancy: { value: tenancy },
    selectedOS: { value: config.selectedOS || 'linux' },
    workloadSelection: { value: 'consistent' },
    instanceType: { value: config.instanceType || '' },
    workload: { value: { workloadType: 'consistent', data: String(config.quantity || '1') } },
    pricingStrategy: buildPricingStrategy(pricing, utilization, tenancy),
    ec2AdvancedPricingMetrics: { value: 1 },
    detailedMonitoringCheckbox: { value: false },
    ...(config.storageType && { storageType: { value: config.storageType } }),
    ...(config.storageAmount && {
      storageAmount: typeof config.storageAmount === 'object'
        ? config.storageAmount : { value: String(config.storageAmount), unit: 'gb|NA' },
    }),
    ...(config.snapshotFrequency != null && { snapshotFrequency: { value: String(config.snapshotFrequency) } }),
    dataTransferForEC2: config.dataTransferForEC2 || EMPTY_DATA_TRANSFER,
  };
}

module.exports = { transformConfig };
