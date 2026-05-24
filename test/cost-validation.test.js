const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateArr,
  calculateDelta,
  extractTotals,
  flattenServiceCosts,
  validateEstimateCost,
  expectedServicesForVisualCheck,
} = require('../lib/cost-validation');

describe('cost validation helpers', () => {
  it('calculates ARR as monthly cost times 12', () => {
    assert.equal(calculateArr(1000), 12000);
    assert.equal(calculateArr(1234.567), 14814.8);
  });

  it('reports upfront separately from ARR', () => {
    const result = validateEstimateCost({
      totalCost: { monthly: 1000, upfront: 5000 },
      services: {},
      groups: {},
    }, 12000);

    assert.equal(result.passed, true);
    assert.equal(result.actual_arr, 12000);
    assert.equal(result.upfront_total, 5000);
  });

  it('calculates delta and percent', () => {
    assert.deepEqual(calculateDelta(10000, 12000), {
      delta: 2000,
      deltaPercent: 20,
    });
  });

  it('passes and fails using tolerance', () => {
    const pass = validateEstimateCost({ totalCost: { monthly: 1050 }, services: {}, groups: {} }, 12000, 10);
    const fail = validateEstimateCost({ totalCost: { monthly: 1300 }, services: {}, groups: {} }, 12000, 10);

    assert.equal(pass.passed, true);
    assert.equal(pass.delta_percent, 5);
    assert.equal(fail.passed, false);
    assert.equal(fail.delta_percent, 30);
    assert.ok(fail.warnings.some(w => w.includes('above expected ARR')));
  });

  it('handles missing monthly totals as a failed validation', () => {
    const result = validateEstimateCost({ totalCost: {}, services: {}, groups: {} }, 12000);
    assert.equal(result.passed, false);
    assert.equal(result.actual_arr, null);
    assert.ok(result.warnings.some(w => w.includes('totalCost.monthly')));
  });

  it('extracts totals', () => {
    const totals = extractTotals({ totalCost: { monthly: 12.34, upfront: 56.78 } });
    assert.deepEqual(totals, { monthly: 12.34, upfront: 56.78 });
  });

  it('flattens grouped and ungrouped cost drivers', () => {
    const drivers = flattenServiceCosts({
      services: {
        'lambda-1': {
          serviceName: 'AWS Lambda',
          description: 'API',
          serviceCost: { monthly: 100 },
        },
      },
      groups: {
        'prod-1': {
          name: 'Production',
          services: {
            'ec2-1': {
              serviceName: 'Amazon EC2',
              description: 'Web',
              serviceCost: { monthly: 500, upfront: 50 },
            },
          },
        },
      },
    });

    assert.equal(drivers.length, 2);
    assert.equal(drivers[0].service, 'Amazon EC2');
    assert.equal(drivers[0].group, 'Production');
    assert.equal(drivers[0].arr, 6000);
    assert.equal(drivers[1].service, 'AWS Lambda');
  });

  it('deduplicates service names for visual checks', () => {
    const services = expectedServicesForVisualCheck({
      services: {
        a: { serviceName: 'AWS Lambda', serviceCost: { monthly: 10 } },
        b: { serviceName: 'AWS Lambda', serviceCost: { monthly: 20 } },
      },
    });
    assert.deepEqual(services, [{ name: 'AWS Lambda' }]);
  });

  it('validates mocked AWS readback shape end-to-end', () => {
    const result = validateEstimateCost({
      name: 'Mock AWS Estimate',
      totalCost: { monthly: 10000, upfront: 1000 },
      services: {
        'ec2-1': {
          serviceName: 'Amazon EC2',
          description: 'Compute',
          serviceCost: { monthly: 9000 },
        },
      },
      groups: {
        'data-1': {
          name: 'Data',
          services: {
            'rds-1': {
              serviceName: 'Amazon RDS',
              description: 'Database',
              serviceCost: { monthly: 1000 },
            },
          },
        },
      },
    }, 120000, 1);

    assert.equal(result.passed, true);
    assert.equal(result.actual_monthly, 10000);
    assert.equal(result.actual_arr, 120000);
    assert.equal(result.top_cost_drivers[0].service, 'Amazon EC2');
  });
});
