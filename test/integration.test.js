/**
 * Integration test - hits the real AWS Calculator save API.
 * Run with: RUN_INTEGRATION=1 node --test test/integration.test.js
 * Included in the normal glob, but skipped unless RUN_INTEGRATION=1.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EstimateBuilder = require('../lib/estimate-builder');

describe('integration: export to calculator.aws', { skip: process.env.RUN_INTEGRATION !== '1' }, () => {
  it('builds and saves a Lambda estimate, returns a working URL', async () => {
    const eb = new EstimateBuilder('Integration Test');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API handler',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
      requestDuration: { value: '200', unit: 'ms' },
    });

    const result = await eb.export();

    assert.ok(result.estimateId, 'should return an estimateId');
    assert.ok(result.shareableUrl, 'should return a shareableUrl');
    assert.ok(
      result.shareableUrl.startsWith('https://calculator.aws/'),
      `URL should start with https://calculator.aws/, got: ${result.shareableUrl}`
    );
    assert.ok(
      result.shareableUrl.includes(result.estimateId),
      'URL should contain the estimate ID'
    );

    console.log(`\n  Shareable URL: ${result.shareableUrl}\n`);
  });
});
