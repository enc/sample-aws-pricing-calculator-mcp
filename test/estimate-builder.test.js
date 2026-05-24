const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const EstimateBuilder = require('../lib/estimate-builder');

// --- helpers for toAWSPayload tests ---

function clearAwsClientCache() {
  const mod = require.resolve('../lib/aws-client');
  delete require.cache[mod];
  // estimate-builder caches the require too, so clear it as well
  const ebMod = require.resolve('../lib/estimate-builder');
  delete require.cache[ebMod];
}

function mockFetch(responses) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    for (const [pattern, body] of responses) {
      if (url.includes(pattern)) {
        return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '404' };
  };
  return calls;
}

const FAKE_MANIFEST = {
  awsServices: [
    { key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' },
    { key: 'amazonS3Standard', name: 'Amazon S3 Standard', serviceCode: 'amazonS3Standard' },
  ],
};

const FAKE_DEFINITION = {
  version: '2.0.0',
  serviceCode: 'aWSLambda',
  templates: [{ id: 'lambda-template-1' }],
};

const FAKE_S3_DEFINITION = {
  version: '1.5.0',
  serviceCode: 'amazonS3Standard',
  templates: [{ id: 's3-template-1' }],
};

describe('EstimateBuilder', () => {
  describe('description field', () => {
    it('defaults to empty string when no description provided', async () => {
      const { sanitize } = require('../lib/estimate-builder');
      const result = sanitize(undefined);
      assert.equal(result, '', 'sanitize(undefined) should return empty string');
      assert.equal(sanitize(undefined) || null, null, 'demonstrates the bug with || null');
    });
  });

  describe('addService deduplication', () => {
    it('deduplicates same service key using description', () => {
      const eb = new EstimateBuilder('test');
      const first = eb.addService('aWSLambda', { description: 'API handler', region: 'us-east-1' });
      const second = eb.addService('aWSLambda', { description: 'Cron jobs', region: 'us-east-1' });
      const keys = Object.keys(eb.services);
      assert.equal(first, 'aWSLambda');
      assert.equal(second, 'aWSLambda:Cronjobs');
      assert.equal(keys.length, 2, 'should have two entries');
      assert.ok(keys.includes('aWSLambda'), 'first entry uses original key');
      assert.ok(keys.some(k => k.includes('Cronjobs')), 'second entry has description suffix');
    });

    it('deduplicates repeated service keys without descriptions', () => {
      const eb = new EstimateBuilder('test');
      const first = eb.addService('aWSLambda', { region: 'us-east-1' });
      const second = eb.addService('aWSLambda', { region: 'us-east-1' });
      const keys = Object.keys(eb.services);
      assert.equal(first, 'aWSLambda');
      assert.equal(second, 'aWSLambda:2');
      assert.deepEqual(keys, ['aWSLambda', 'aWSLambda:2']);
    });

    it('deduplicates repeated service keys with the same description', () => {
      const eb = new EstimateBuilder('test');
      eb.addService('aWSLambda', { description: 'API handler', region: 'us-east-1' });
      eb.addService('aWSLambda', { description: 'API handler', region: 'us-east-1' });
      const third = eb.addService('aWSLambda', { description: 'API handler', region: 'us-east-1' });
      assert.equal(third, 'aWSLambda:2');
      assert.equal(Object.keys(eb.services).length, 3);
    });

    it('recognizes ec2Enhancement as EC2 service', () => {
      const eb = new EstimateBuilder('test');
      // Agents use ec2Enhancement (from search) not eC2Next (inactive)
      // _isEC2 must recognize both keys so the EC2 transform is applied
      assert.ok(eb._isEC2({ key: 'ec2Enhancement' }), 'should recognize ec2Enhancement');
      assert.ok(!eb._isEC2({ key: 'eC2Next' }), 'eC2Next is inactive, not supported');
      assert.ok(!eb._isEC2({ key: 'aWSLambda' }), 'should not match other services');
    });

    it('places services in groups when specified', () => {
      const eb = new EstimateBuilder('test');
      eb.addService('aWSLambda', { region: 'us-east-1' }, { group: 'Prod' });
      assert.equal(Object.keys(eb.services).length, 0, 'ungrouped should be empty');
      assert.ok(eb.groups.Prod, 'Prod group should exist');
      assert.equal(Object.keys(eb.groups.Prod.services).length, 1);
    });
  });
});

describe('toAWSPayload', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    clearAwsClientCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearAwsClientCache();
  });

  it('builds a full exportable payload with ungrouped services', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('Test Estimate');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API handler',
      numberOfRequests: { value: '1000', unit: 'millionPerMonth' },
    });

    const payload = await eb.toAWSPayload();

    // Top-level structure
    assert.equal(payload.name, 'Test Estimate');
    assert.ok(payload.services, 'should have services');
    assert.ok(payload.groups, 'should have groups');
    assert.ok(payload.metaData, 'should have metaData');
    assert.equal(payload.metaData.currency, 'USD');
    assert.equal(payload.settings, undefined, 'aws partition should not have settings');

    // Service entry
    const entries = Object.values(payload.services);
    assert.equal(entries.length, 1, 'should have one service');
    const svc = entries[0];
    assert.equal(svc.serviceCode, 'aWSLambda');
    assert.equal(svc.region, 'us-east-1');
    assert.equal(svc.regionName, 'US East (N. Virginia)');
    assert.equal(svc.version, '2.0.0');
    assert.equal(svc.estimateFor, 'lambda-template-1');
    assert.equal(svc.description, 'API handler');
    assert.deepEqual(svc.calculationComponents.numberOfRequests, { value: '1000', unit: 'millionPerMonth' });
  });

  it('builds payload with grouped services', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
      ['data/amazonS3Standard', FAKE_S3_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('Grouped Estimate');
    eb.addService('aWSLambda', { region: 'eu-west-1', description: 'Compute' }, { group: 'Prod' });
    eb.addService('amazonS3Standard', { region: 'eu-west-1', description: 'Storage' }, { group: 'Prod' });

    const payload = await eb.toAWSPayload();

    assert.equal(Object.keys(payload.services).length, 0, 'ungrouped should be empty');
    const groupEntries = Object.values(payload.groups);
    assert.equal(groupEntries.length, 1);
    const group = groupEntries[0];
    assert.equal(group.name, 'Prod');
    const groupServices = Object.values(group.services);
    assert.equal(groupServices.length, 2);
    const codes = groupServices.map(s => s.serviceCode).sort();
    assert.deepEqual(codes, ['aWSLambda', 'amazonS3Standard']);
  });

  it('falls back gracefully when definition fetch fails', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      // no definition response — will 404
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('Fallback Test');
    eb.addService('aWSLambda', { region: 'us-east-1', description: 'Test' });

    const payload = await eb.toAWSPayload();
    const svc = Object.values(payload.services)[0];
    // Should use fallback values
    assert.equal(svc.version, '0.0.1');
    assert.equal(svc.estimateFor, 'template');
  });
});

describe('partition support', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    clearAwsClientCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearAwsClientCache();
  });

  it('resolvePartition maps regions correctly', () => {
    const { resolvePartition } = require('../lib/aws-client');
    assert.equal(resolvePartition('us-east-1'), 'aws');
    assert.equal(resolvePartition('eu-west-1'), 'aws');
    assert.equal(resolvePartition('us-iso-east-1'), 'aws-iso');
    assert.equal(resolvePartition('us-iso-west-1'), 'aws-iso');
    assert.equal(resolvePartition('us-isob-east-1'), 'aws-iso-b');
    assert.equal(resolvePartition(null), 'aws');
    assert.equal(resolvePartition(undefined), 'aws');
    assert.equal(resolvePartition(''), 'aws');
  });

  it('_buildShareUrl includes contract param for ISO partitions', () => {
    const EB = require('../lib/estimate-builder');
    const eb = new EB('test');
    const awsUrl = eb._buildShareUrl('abc-123', 'aws');
    assert.ok(!awsUrl.includes('ctrct='), 'aws should not have contract param');
    assert.ok(awsUrl.includes('id=abc-123'));

    const isoUrl = eb._buildShareUrl('abc-123', 'aws-iso');
    assert.ok(isoUrl.includes('ctrct='), 'aws-iso should have contract param');
    assert.ok(isoUrl.includes('id=abc-123'));

    const isobUrl = eb._buildShareUrl('abc-123', 'aws-iso-b');
    assert.ok(isobUrl.includes('ctrct='), 'aws-iso-b should have contract param');
  });

  it('auto-detects partition from ISO region', async () => {
    const FAKE_ISO_MANIFEST = {
      awsServices: [{ key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' }],
    };
    const calls = mockFetch([
      ['aws-iso/manifest', FAKE_ISO_MANIFEST],
      ['aws-iso/data/aWSLambda', FAKE_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('ISO Test');
    eb.addService('aWSLambda', { region: 'us-iso-east-1', description: 'Test' });

    const payload = await eb.toAWSPayload();
    assert.ok(payload.settings, 'ISO partition should have settings');
    assert.equal(payload.settings.awsPartition, 'aws-iso');
    assert.ok(calls.some(c => c.url.includes('aws-iso/manifest')), 'should fetch ISO manifest');
  });

  it('rejects mixed-partition estimates', () => {
    const EB = require('../lib/estimate-builder');
    const eb = new EB('Mixed Test');
    eb.addService('aWSLambda', { region: 'us-east-1', description: 'Commercial' });
    eb.addService('amazonS3Standard', { region: 'us-iso-east-1', description: 'ISO' });

    assert.rejects(() => eb.toAWSPayload(), /Mixed-partition/);
  });

  it('uses explicit partition over auto-detection', async () => {
    const FAKE_ISO_MANIFEST = {
      awsServices: [{ key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' }],
    };
    mockFetch([
      ['aws-iso/manifest', FAKE_ISO_MANIFEST],
      ['aws-iso/data/aWSLambda', FAKE_DEFINITION],
    ]);

    const EB = require('../lib/estimate-builder');
    const eb = new EB('Explicit Partition', 'aws-iso');
    eb.addService('aWSLambda', { region: 'us-iso-east-1', description: 'Test' });

    const payload = await eb.toAWSPayload();
    assert.equal(payload.settings.awsPartition, 'aws-iso');
  });

  it('loadManifest rejects unknown partition', async () => {
    const { loadManifest } = require('../lib/aws-client');
    await assert.rejects(() => loadManifest('aws-govcloud'), /Unknown partition/);
  });
});
