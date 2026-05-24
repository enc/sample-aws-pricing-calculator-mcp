const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function clearCaches() {
  delete require.cache[require.resolve('../lib/aws-client')];
  delete require.cache[require.resolve('../lib/estimate-builder')];
  delete require.cache[require.resolve('../mcp-server')];
}

function mockFetch(responses) {
  global.fetch = async (url, opts) => {
    for (const [pattern, body] of responses) {
      if (url.includes(pattern)) {
        return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '404' };
  };
}

const FAKE_MANIFEST = {
  awsServices: [
    { key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' },
  ],
};

const FAKE_DEFINITION = {
  version: '2.0.0',
  serviceCode: 'aWSLambda',
  templates: [{ id: 'lambda-template-1' }],
};

const SAVE_RESPONSE = {
  statusCode: 200,
  body: JSON.stringify({ savedKey: 'abc123' }),
};

const READBACK_RESPONSE = {
  name: 'AWS calculated estimate',
  totalCost: { monthly: 1000, upfront: 250 },
  services: {
    'aWSLambda-1': {
      serviceName: 'AWS Lambda',
      description: 'API handler',
      serviceCost: { monthly: 1000 },
    },
  },
  groups: {},
};

describe('validate_estimate_cost handler', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    clearCaches();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearCaches();
  });

  it('exports, reads back AWS totals, and validates ARR within tolerance', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
      ['saveAs', SAVE_RESPONSE],
      ['d3knqfixx3sbls.cloudfront.net/abc123', READBACK_RESPONSE],
    ]);

    const EstimateBuilder = require('../lib/estimate-builder');
    const { validateEstimateCostForEstimate } = require('../mcp-server');
    const eb = new EstimateBuilder('Cost validation test');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API handler',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
    });

    const result = await validateEstimateCostForEstimate(eb, {
      estimate_id: eb.id,
      expected_annual_recurring: 12000,
    });

    assert.equal(result.passed, true);
    assert.equal(result.aws_estimate_id, 'abc123');
    assert.equal(result.shareable_url, 'https://calculator.aws/#/estimate?id=abc123');
    assert.equal(result.actual_monthly, 1000);
    assert.equal(result.actual_arr, 12000);
    assert.equal(result.upfront_total, 250);
    assert.equal(result.top_cost_drivers[0].service, 'AWS Lambda');
  });

  it('fails when AWS calculated ARR is outside tolerance', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
      ['saveAs', SAVE_RESPONSE],
      ['d3knqfixx3sbls.cloudfront.net/abc123', READBACK_RESPONSE],
    ]);

    const EstimateBuilder = require('../lib/estimate-builder');
    const { validateEstimateCostForEstimate } = require('../mcp-server');
    const eb = new EstimateBuilder('Cost validation test');
    eb.addService('aWSLambda', {
      region: 'us-east-1',
      description: 'API handler',
      numberOfRequests: { value: '1', unit: 'millionPerMonth' },
    });

    const result = await validateEstimateCostForEstimate(eb, {
      estimate_id: eb.id,
      expected_annual_recurring: 10000,
      tolerance_percent: 5,
    });

    assert.equal(result.passed, false);
    assert.equal(result.delta_percent, 20);
    assert.ok(result.warnings.some(w => w.includes('above expected ARR')));
  });
});
