// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const crypto = require('crypto');
const { PARTITIONS, resolvePartition, loadManifest, findService, fetchServiceDefinition, saveEstimate } = require('./aws-client');
const ec2 = require('./ec2');

const REGIONS = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'af-south-1': 'Africa (Cape Town)',
  'ap-east-1': 'Asia Pacific (Hong Kong)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-south-2': 'Asia Pacific (Hyderabad)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-southeast-3': 'Asia Pacific (Jakarta)',
  'ap-southeast-4': 'Asia Pacific (Melbourne)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ca-central-1': 'Canada (Central)',
  'ca-west-1': 'Canada West (Calgary)',
  'eu-central-1': 'Europe (Frankfurt)',
  'eu-central-2': 'Europe (Zurich)',
  'eu-west-1': 'Europe (Ireland)',
  'eu-west-2': 'Europe (London)',
  'eu-west-3': 'Europe (Paris)',
  'eu-south-1': 'Europe (Milan)',
  'eu-south-2': 'Europe (Spain)',
  'eu-north-1': 'Europe (Stockholm)',
  'il-central-1': 'Israel (Tel Aviv)',
  'me-south-1': 'Middle East (Bahrain)',
  'me-central-1': 'Middle East (UAE)',
  'sa-east-1': 'South America (Sao Paulo)',
  'us-iso-east-1': 'US ISO East',
  'us-iso-west-1': 'US ISO West',
  'us-isob-east-1': 'US ISOB East (Ohio)',
};

function sanitize(str) {
  return (str || '').replace(/[<>&]/g, '');
}

function wrapValues(config) {
  const components = {};
  for (const [k, v] of Object.entries(config)) {
    if (k === 'region' || k === 'description') continue;
    if (v == null) continue;
    components[k] = (typeof v === 'object') ? v : { value: String(v) };
  }
  return components;
}

function configSummary(config) {
  return Object.entries(config)
    .filter(([k, v]) => k !== 'region' && k !== 'description' && v != null)
    .map(([k, v]) => `${k} (${(v && typeof v === 'object') ? v.value : v})`)
    .join(', ');
}

class EstimateBuilder {
  constructor(name = 'My Estimate', partition = null) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.partition = partition;
    this.services = {};
    this.groups = {};
    this.usedKeys = new Set();
  }

  addService(compositeKey, config, { group } = {}) {
    if (this.usedKeys.has(compositeKey) && config?.description) {
      compositeKey = `${compositeKey}:${config.description.replace(/\s+/g, '')}`;
    }
    this.usedKeys.add(compositeKey);
    const target = group
      ? (this.groups[group] ??= { services: {} }).services
      : this.services;
    target[compositeKey] = config;
  }

  _resolvePartition() {
    if (this.partition) return this.partition;
    const allConfigs = [
      ...Object.values(this.services),
      ...Object.values(this.groups).flatMap(g => Object.values(g.services)),
    ];
    for (const config of allConfigs) {
      if (config.region) {
        const p = resolvePartition(config.region);
        if (p !== 'aws') return p;
      }
    }
    return 'aws';
  }

  _validatePartitionConsistency() {
    const allConfigs = [
      ...Object.values(this.services),
      ...Object.values(this.groups).flatMap(g => Object.values(g.services)),
    ];
    const partitions = new Set();
    for (const config of allConfigs) {
      if (config.region) {
        partitions.add(resolvePartition(config.region));
      }
    }
    if (partitions.size > 1) {
      throw new Error(`Mixed-partition estimates are not supported. Found regions from partitions: ${[...partitions].join(', ')}`);
    }
  }

  async toAWSPayload() {
    const partition = this._resolvePartition();
    this._validatePartitionConsistency();
    const manifest = await loadManifest(partition);

    const buildEntries = async (serviceMap) => {
      const out = {};
      for (const [compositeKey, config] of Object.entries(serviceMap)) {
        const svc = findService(manifest, compositeKey.split(':')[0]);
        if (!svc) continue;
        out[`${this._payloadKey(svc)}-${crypto.randomUUID()}`] =
          await this._buildServiceConfig(manifest, svc, config, partition);
      }
      return out;
    };

    const groups = {};
    for (const [name, data] of Object.entries(this.groups)) {
      const safeName = sanitize(name);
      groups[`${safeName}-${crypto.randomUUID()}`] = {
        name: safeName,
        services: await buildEntries(data.services),
        groups: {},
        groupSubtotal: { monthly: 0 },
        totalCost: { monthly: 0, upfront: 0 },
      };
    }

    const payload = {
      name: this.name,
      services: await buildEntries(this.services),
      groups,
      groupSubtotal: {},
      totalCost: { monthly: 0, upfront: 0 },
      support: {},
      metaData: {
        locale: 'en_US',
        currency: 'USD',
        createdOn: new Date().toISOString(),
        source: 'calculator-platform',
      },
    };

    if (partition !== 'aws') {
      payload.settings = {
        subTotalModifier: { type: 'VOLUME_DISCOUNT', value: 0, valuePercentage: 0, label: 'Discount' },
        monthlyTimeFrame: 12,
        timeFrame: { length: 12, unit: 'month' },
        awsPartition: PARTITIONS[partition].awsPartition,
      };
    }

    return payload;
  }

  async export() {
    const payload = await this.toAWSPayload();
    const result = await saveEstimate(payload);
    const partition = this._resolvePartition();
    return {
      estimateId: result.estimateId,
      shareableUrl: this._buildShareUrl(result.estimateId, partition),
    };
  }

  _buildShareUrl(savedKey, partition) {
    const contract = PARTITIONS[partition]?.contract;
    if (contract) {
      return `https://calculator.aws/#/estimate?ctrct=${contract}&volume_discount=0&id=${savedKey}`;
    }
    return `https://calculator.aws/#/estimate?id=${savedKey}`;
  }

  _isEC2(service) {
    return service.key.toLowerCase() === 'ec2enhancement';
  }

  _payloadKey(service) {
    return this._isEC2(service) ? 'ec2Enhancement' : service.key;
  }

  async _buildServiceConfig(manifest, service, config, partition) {
    const region = config.region || 'us-east-1';
    const defKey = this._payloadKey(service);

    let version = '0.0.1', serviceCode = defKey, estimateFor = 'template';
    try {
      const def = await fetchServiceDefinition(manifest, defKey, partition);
      if (def) {
        version = def.version || version;
        serviceCode = def.serviceCode || serviceCode;
        estimateFor = def.templates?.[0]?.id || estimateFor;
      }
    } catch (err) {
      console.error(`Failed to fetch definition for ${defKey}: ${err.message}`);
    }

    return {
      serviceCode,
      region,
      estimateFor,
      description: sanitize(config.description),
      serviceCost: { monthly: 0, upfront: 0 },
      serviceName: service.name,
      regionName: REGIONS[region] || region,
      version,
      calculationComponents: this._isEC2(service) ? ec2.transformConfig(config) : wrapValues(config),
      configSummary: configSummary(config),
    };
  }
}

module.exports = EstimateBuilder;
module.exports.sanitize = sanitize;
