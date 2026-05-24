const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function mockManifest() {
  return new Map([
    ['aWSLambda', { key: 'aWSLambda', name: 'AWS Lambda', searchKeywords: ['serverless', 'functions'] }],
    ['amazonS3Standard', { key: 'amazonS3Standard', name: 'Amazon S3 Standard', searchKeywords: ['storage', 'object store'] }],
    ['amazonSimpleNotificationService', { key: 'amazonSimpleNotificationService', name: 'Amazon SNS', subType: 'subServiceSelector' }],
    ['standardTopics', { key: 'standardTopics', name: 'Amazon SNS Standard Topics', searchKeywords: ['notification'] }],
    ['eC2Next', { key: 'eC2Next', name: 'Amazon EC2', isActive: 'false' }],
    ['ec2Enhancement', { key: 'ec2Enhancement', name: 'Amazon EC2', isActive: 'true' }],
  ]);
}

describe('searchServices', () => {
  it('finds services by name', () => {
    const { searchServices } = require('../lib/aws-client');
    const results = searchServices(mockManifest(), 'lambda');
    assert.equal(results.length, 1);
    assert.equal(results[0].key, 'aWSLambda');
  });

  it('finds services by keyword', () => {
    const { searchServices } = require('../lib/aws-client');
    const results = searchServices(mockManifest(), 'serverless');
    assert.equal(results.length, 1);
    assert.equal(results[0].key, 'aWSLambda');
  });

  it('excludes inactive services', () => {
    const { searchServices } = require('../lib/aws-client');
    const results = searchServices(mockManifest(), 'ec2');
    const keys = results.map(r => r.key);
    assert.ok(!keys.includes('eC2Next'), 'should exclude inactive eC2Next');
    assert.ok(keys.includes('ec2Enhancement'), 'should include active ec2Enhancement');
  });

  it('excludes subServiceSelector parents', () => {
    const { searchServices } = require('../lib/aws-client');
    const results = searchServices(mockManifest(), 'sns');
    const keys = results.map(r => r.key);
    assert.ok(!keys.includes('amazonSimpleNotificationService'));
  });

  it('handles multiple comma-separated terms', () => {
    const { searchServices } = require('../lib/aws-client');
    const results = searchServices(mockManifest(), 'lambda, s3');
    assert.ok(results.lambda, 'should have lambda key');
    assert.ok(results.s3, 'should have s3 key');
    assert.equal(results.lambda.length, 1);
    assert.equal(results.s3.length, 1);
  });

  it('returns empty array for no matches', () => {
    const { searchServices } = require('../lib/aws-client');
    const results = searchServices(mockManifest(), 'nonexistent');
    assert.equal(results.length, 0);
  });
});

describe('parseDoubleEncodedResponse', () => {
  it('parses valid double-encoded AWS response', () => {
    const { parseDoubleEncodedResponse } = require('../lib/aws-client');
    const raw = JSON.stringify({
      statusCode: 200,
      body: JSON.stringify({ savedKey: 'abc123' }),
    });
    const result = parseDoubleEncodedResponse(raw);
    assert.equal(result.savedKey, 'abc123');
  });

  it('throws on invalid outer JSON', () => {
    const { parseDoubleEncodedResponse } = require('../lib/aws-client');
    assert.throws(() => parseDoubleEncodedResponse('not json'), /invalid JSON/i);
  });

  it('throws on invalid inner body JSON', () => {
    const { parseDoubleEncodedResponse } = require('../lib/aws-client');
    const raw = JSON.stringify({ body: 'not json' });
    assert.throws(() => parseDoubleEncodedResponse(raw), /invalid body/i);
  });

  it('throws when savedKey is missing', () => {
    const { parseDoubleEncodedResponse } = require('../lib/aws-client');
    const raw = JSON.stringify({ body: JSON.stringify({ other: 'data' }) });
    assert.throws(() => parseDoubleEncodedResponse(raw), /savedKey/i);
  });
});

describe('extractInputFields', () => {
  const { extractInputFields, buildServiceConfigSchema } = require('../lib/aws-client');

  it('extracts numericInput fields', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'requestCount', type: 'numericInput', label: 'Requests' },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].id, 'requestCount');
    assert.equal(fields[0].type, 'numericInput');
    assert.equal(fields[0].label, 'Requests');
  });

  it('extracts dropdown subType fields', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'storageClass', type: 'input', subType: 'dropdown', label: 'Storage class',
        options: [{ id: 'standard', label: 'Standard' }, { id: 'ia', label: 'Infrequent Access' }] },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].type, 'dropdown');
    assert.equal(fields[0].options.length, 2);
    assert.equal(fields[0].options[0].id, 'standard');
  });

  it('skips WithoutFreeTier and _MVP duplicates', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'requests', type: 'numericInput', label: 'Requests' },
      { id: 'requestsWithoutFreeTier', type: 'numericInput', label: 'Requests (no free tier)' },
      { id: 'duration_MVP', type: 'numericInput', label: 'Duration MVP' },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1, 'should only include the base field');
    assert.equal(fields[0].id, 'requests');
  });

  it('deduplicates fields repeated across templates', () => {
    const def = { templates: [
      { id: 'tpl1', groups: [{ items: [{ id: 'region', type: 'input', subType: 'dropdown' }] }] },
      { id: 'tpl2', groups: [{ items: [{ id: 'region', type: 'input', subType: 'dropdown' }] }] },
    ]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1, 'should deduplicate');
  });

  it('includes fileSize metadata', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'storage', type: 'fileSize', label: 'Storage',
        dropDownSize: [{ value: 'gb' }, { value: 'tb' }],
        defaultOption: { size: 'gb', frequency: 'NA' } },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1);
    assert.deepEqual(fields[0].validSizes, ['gb', 'tb']);
    assert.equal(fields[0].defaultUnit, 'gb|NA');
  });

  it('skips decorative types like bodyText and headerText', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'header1', type: 'input', subType: 'headerText' },
      { id: 'body1', type: 'input', subType: 'bodyText' },
      { id: 'alert1', type: 'input', subType: 'alert' },
      { id: 'actual', type: 'numericInput', label: 'Value' },
    ]}]}]};
    const fields = extractInputFields(def);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].id, 'actual');
  });

  it('builds an AI-ready config schema with examples', () => {
    const def = { templates: [{ id: 'tpl', groups: [{ items: [
      { id: 'numberOfRequests', type: 'numericInput', label: 'Requests' },
      { id: 'storage', type: 'fileSize', label: 'Storage',
        dropDownSize: [{ value: 'gb' }, { value: 'tb' }],
        defaultOption: { size: 'gb', frequency: 'NA' } },
      { id: 'storageClass', type: 'input', subType: 'dropdown', label: 'Storage class',
        options: [{ id: 'standard', label: 'Standard' }] },
    ]}]}]};
    const fields = extractInputFields(def);
    const schema = buildServiceConfigSchema({ key: 'amazonS3Standard', name: 'Amazon S3 Standard' }, fields);
    const byId = Object.fromEntries(schema.fields.map(f => [f.id, f]));
    assert.equal(schema.configShape.region.includes('required'), true);
    assert.equal(byId.numberOfRequests.example, '1');
    assert.deepEqual(byId.storage.example, { value: '100', unit: 'gb|NA' });
    assert.equal(byId.storageClass.example, 'standard');
  });
});
