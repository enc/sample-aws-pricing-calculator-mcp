const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// The helpers are in mcp-server.js which isn't structured for direct import.
// Re-implement the pure functions here to test them, then test validateConfigKeys via integration.

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

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('abc', 'abc'), 0);
  });

  it('returns length for empty vs non-empty', () => {
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', ''), 3);
  });

  it('computes correct distance for similar strings', () => {
    assert.equal(levenshtein('numberOfRequests', 'NumberofRequests'), 2);
    assert.equal(levenshtein('kitten', 'sitting'), 3);
  });
});

describe('suggestMatch', () => {
  const validIds = [
    'numberOfRequests', 'durationOfEachRequest', 'sizeOfMemoryAllocated',
    'storageAmountEphemeral', 'selectArchitectureRequests',
  ];

  it('suggests close matches for typos', () => {
    const result = suggestMatch('NumberofRequests', validIds);
    assert.ok(result.includes('numberOfRequests'), `Expected numberOfRequests in ${result}`);
  });

  it('suggests sizeOfMemoryAllocated for close misspelling', () => {
    const result = suggestMatch('sizeOfMemoryAlocated', validIds);
    assert.ok(result.includes('sizeOfMemoryAllocated'), `Expected sizeOfMemoryAllocated in ${result}`);
  });

  it('returns empty array for completely unrelated input', () => {
    const result = suggestMatch('xyzzy', validIds);
    assert.equal(result.length, 0);
  });

  it('returns at most max suggestions', () => {
    const result = suggestMatch('storage', validIds, 2);
    assert.ok(result.length <= 2);
  });
});

describe('validateConfigKeys (integration)', () => {
  let originalFetch;

  function clearCaches() {
    delete require.cache[require.resolve('../lib/aws-client')];
    delete require.cache[require.resolve('../lib/estimate-builder')];
    delete require.cache[require.resolve('../mcp-server')];
  }

  beforeEach(() => {
    originalFetch = global.fetch;
    clearCaches();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearCaches();
  });

  function mockFetch(responses) {
    global.fetch = async (url) => {
      for (const [pattern, body] of responses) {
        if (url.includes(pattern)) {
          return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
        }
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '404' };
    };
  }

  // Replicate validateConfigKeys using the real aws-client module
  async function validateConfigKeys(serviceKey, config, partition) {
    const { loadManifest, findService, fetchServiceDefinition, extractInputFields } = require('../lib/aws-client');
    const META_KEYS = new Set(['region', 'description']);
    if (serviceKey.toLowerCase() === 'ec2enhancement') return null;
    const configKeys = Object.keys(config).filter(k => !META_KEYS.has(k));
    if (configKeys.length === 0) return null;
    try {
      const manifest = await loadManifest(partition || 'aws');
      const svc = findService(manifest, serviceKey);
      if (!svc) return null;
      const def = await fetchServiceDefinition(manifest, svc.key, partition || 'aws');
      if (!def) return null;
      const validIds = extractInputFields(def).map(f => f.id);
      const validSet = new Set(validIds);
      const invalid = configKeys.filter(k => !validSet.has(k));
      if (invalid.length === 0) return null;
      const lines = invalid.map(k => {
        const suggestions = suggestMatch(k, validIds);
        return suggestions.length
          ? `  "${k}" — did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?`
          : `  "${k}" — no close match found`;
      });
      return `Invalid field IDs for ${svc.key}:\n${lines.join('\n')}\nUse get_service_fields to discover valid field IDs.`;
    } catch { return null; }
  }

  const FAKE_MANIFEST = {
    awsServices: [
      { key: 'aWSLambda', name: 'AWS Lambda', serviceCode: 'aWSLambda' },
    ],
  };

  const FAKE_DEFINITION = {
    version: '1.0.0',
    serviceCode: 'aWSLambda',
    templates: [{
      id: 'tmpl',
      inputComponents: [
        { id: 'numberOfRequests', type: 'numericInput' },
        { id: 'durationOfEachRequest', type: 'numericInput' },
        { id: 'sizeOfMemoryAllocated', type: 'numericInput' },
      ],
    }],
  };

  it('returns null for valid config keys', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      description: 'test',
      numberOfRequests: '100',
    });
    assert.equal(result, null);
  });

  it('returns error with suggestions for invalid keys', async () => {
    mockFetch([
      ['manifest/en_US.json', FAKE_MANIFEST],
      ['data/aWSLambda', FAKE_DEFINITION],
    ]);
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      NumberofRequests: '100',
    });
    assert.ok(result, 'should return an error');
    assert.ok(result.includes('NumberofRequests'), 'should mention the invalid key');
    assert.ok(result.includes('numberOfRequests'), 'should suggest the correct key');
    assert.ok(result.includes('get_service_fields'), 'should mention get_service_fields');
  });

  it('skips validation for EC2', async () => {
    const result = await validateConfigKeys('ec2Enhancement', {
      region: 'us-east-1',
      instanceType: 'm5.large',
      totallyFakeField: 'whatever',
    });
    assert.equal(result, null);
  });

  it('returns null when only meta keys are present', async () => {
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      description: 'test',
    });
    assert.equal(result, null);
  });

  it('returns null gracefully when definition fetch fails', async () => {
    mockFetch([]); // everything 404s
    const result = await validateConfigKeys('aWSLambda', {
      region: 'us-east-1',
      badField: '100',
    });
    assert.equal(result, null, 'should not block on fetch failure');
  });
});

describe('config validation helpers', () => {
  const { validateAgainstFields, validateEc2Config, validateServiceConfig } = require('../lib/config-validation');

  it('requires region before service config validation', async () => {
    const result = await validateServiceConfig('aWSLambda', { numberOfRequests: '1' });
    assert.match(result, /region/);
  });

  it('rejects invalid numeric values', () => {
    const errors = validateAgainstFields('aWSLambda', {
      region: 'us-east-1',
      numberOfRequests: 'many',
    }, [
      { id: 'numberOfRequests', type: 'numericInput', label: 'Requests' },
    ]);
    assert.ok(errors.some(e => e.includes('numeric')));
  });

  it('rejects invalid fileSize units', () => {
    const errors = validateAgainstFields('amazonS3Standard', {
      region: 'us-east-1',
      storage: { value: '100', unit: 'parsec|NA' },
    }, [
      { id: 'storage', type: 'fileSize', validSizes: ['gb', 'tb'] },
    ]);
    assert.ok(errors.some(e => e.includes('Allowed sizes')));
  });

  it('rejects invalid dropdown options', () => {
    const errors = validateAgainstFields('amazonS3Standard', {
      region: 'us-east-1',
      storageClass: 'coldest',
    }, [
      { id: 'storageClass', type: 'dropdown', options: [{ id: 'standard' }, { id: 'ia' }] },
    ]);
    assert.ok(errors.some(e => e.includes('valid option')));
  });

  it('rejects malformed columnFormIPM values', () => {
    const errors = validateAgainstFields('amazonRDSPostgreSQLDB', {
      region: 'us-east-1',
      columnFormIPM: { value: { 'Number of Nodes': { value: '1' } } },
    }, [
      { id: 'columnFormIPM', type: 'columnFormIPM', row: [{ selectorId: 'Number of Nodes', label: 'Nodes' }] },
    ]);
    assert.ok(errors.some(e => e.includes('{ "value": [rowObject] }')));
  });

  it('rejects unsupported EC2 fields and non-numeric quantities', () => {
    const errors = validateEc2Config({
      region: 'us-east-1',
      quantity: 'two',
      madeUp: 'x',
    });
    assert.ok(errors.some(e => e.includes('quantity')));
    assert.ok(errors.some(e => e.includes('madeUp')));
  });
});
