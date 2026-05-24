#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { PARTITIONS, loadManifest, findService, fetchServiceDefinition, extractInputFields, enrichFieldsWithMetadata, buildServiceConfigSchema, searchServices, fetchEstimate, estimateToMarkdown } = require('./lib/aws-client');
const { validateServiceConfig } = require('./lib/config-validation');
const { validateEstimateCost, expectedServicesForVisualCheck } = require('./lib/cost-validation');
const EstimateBuilder = require('./lib/estimate-builder');

const estimates = new Map();

const jsonValue = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValue),
  z.record(jsonValue),
]));

const serviceEntrySchema = z.object({
  service: z.string().describe('AWS Calculator service key, e.g. "aWSLambda" or "ec2Enhancement"'),
  instance: z.string().optional().describe('Optional unique line-item suffix'),
  group: z.string().optional().describe('Optional group name'),
  config: z.record(jsonValue).describe('Config object with required region, optional description, and calculator field IDs'),
});

async function addEntries(estimate, entries) {
  const results = [];
  for (const entry of entries) {
    const { service, instance, group } = entry;
    let config = entry.config;
    if (!service || !config) {
      results.push({ error: 'Missing "service" or "config" in entry', entry });
      continue;
    }
    if (typeof config === 'string') {
      try { config = JSON.parse(config); } catch {
        results.push({ error: 'Invalid JSON in config', service });
        continue;
      }
    }
    const key = instance ? `${service}:${instance}` : service;
    const validationError = await validateServiceConfig(service, config, estimate.partition);
    if (validationError) {
      results.push({ error: validationError, service: key });
      continue;
    }
    const storedKey = estimate.addService(key, config, { group });
    results.push({ success: true, service: storedKey, group: group || '(ungrouped)' });
  }
  return results;
}

async function validateEstimateCostForEstimate(estimate, {
  estimate_id,
  expected_annual_recurring,
  tolerance_percent,
  run_visual_check,
}) {
  const exportResult = await estimate.export();
  const data = await fetchEstimate(exportResult.estimateId);
  const validation = validateEstimateCost(data, expected_annual_recurring, tolerance_percent ?? 10);
  const output = {
    ...validation,
    estimate_id,
    aws_estimate_id: exportResult.estimateId,
    shareable_url: exportResult.shareableUrl,
  };

  if (run_visual_check) {
    try {
      const { validateEstimate } = require('./validation/playwright/validate-estimate');
      output.visual_check = await validateEstimate(
        exportResult.shareableUrl,
        expectedServicesForVisualCheck(data),
        { headless: true }
      );
    } catch (err) {
      output.visual_check = {
        success: false,
        errors: [`Visual check failed to start: ${err.message}`],
      };
    }
  }

  return output;
}

const pkg = require('./package.json');

const server = new McpServer({
  name: pkg.name,
  version: pkg.version,
});

server.tool(
  'get_server_info',
  'Get version and capability information about this MCP server.',
  {},
  async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          tools: ['search_services', 'get_service_fields', 'get_service_config_schema', 'create_estimate', 'add_service', 'add_services_structured', 'export_estimate', 'validate_estimate_cost', 'import_estimate', 'get_server_info'],
          partitions: Object.keys(PARTITIONS),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  'search_services',
  'Search AWS services available in the calculator. Returns service keys and names. Use this to find the correct service key before adding it to an estimate. Supports multiple comma-separated search terms in a single call (e.g. "Lambda, S3, API Gateway, CloudWatch").',
  {
    query: z.string().describe('One or more search terms, comma-separated (e.g. "Lambda, S3, Amazon Personalize, API Gateway, CloudWatch")'),
    partition: z.string().optional().describe('AWS partition to search in (default: "aws"). Valid values: "aws", "aws-iso", "aws-iso-b"'),
  },
  async ({ query, partition }) => {
    const p = partition || 'aws';
    if (!PARTITIONS[p]) {
      return { content: [{ type: 'text', text: `Unknown partition '${p}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}` }], isError: true };
    }
    const manifest = await loadManifest(p);
    const results = searchServices(manifest, query);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

server.tool(
  'get_service_fields',
  'Get the input fields for one or more AWS services. Returns field IDs, types, labels, and valid options. Use this to discover what configuration a service accepts before adding it to an estimate. The field IDs returned here are the exact keys to use in add_service config. Accepts multiple comma-separated service keys. IMPORTANT: When duplicate fields exist with version suffixes (e.g. fieldName and fieldName_v2), ALWAYS use the highest version — it maps to the latest configuration path. Ignore lower versions.',
  { service: z.string().describe('One or more service keys, comma-separated (e.g. "aWSLambda, amazonS3, stepFunctionStandard, amazonApiGateway")'),
    partition: z.string().optional().describe('AWS partition to fetch from (default: "aws"). Valid values: "aws", "aws-iso", "aws-iso-b"'),
  },
  async ({ service, partition }) => {
    const p = partition || 'aws';
    if (!PARTITIONS[p]) {
      return { content: [{ type: 'text', text: `Unknown partition '${p}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}` }], isError: true };
    }
    const manifest = await loadManifest(p);
    const keys = service.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    const errors = [];

    for (const key of keys) {
      const svc = findService(manifest, key);
      if (!svc) { errors.push(`Service "${key}" not found.`); continue; }

      const definition = await fetchServiceDefinition(manifest, svc.key, p);
      if (!definition) { errors.push(`Failed to fetch definition for "${svc.key}".`); continue; }

      const fields = extractInputFields(definition);
      const enriched = await enrichFieldsWithMetadata(definition, fields);
      results.push({ serviceCode: svc.key, serviceName: svc.name, fields: enriched });
    }

    const output = errors.length
      ? { services: results, errors }
      : keys.length === 1 ? results[0] : results;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }
);

server.tool(
  'get_service_config_schema',
  'Get an AI-ready configuration schema for one or more AWS services. Prefer this over get_service_fields when preparing add_services_structured input. Returns required meta fields, value shapes, valid units/options, examples, and row schemas.',
  {
    service: z.string().describe('One or more service keys, comma-separated (e.g. "aWSLambda, amazonS3Standard, ec2Enhancement")'),
    partition: z.string().optional().describe('AWS partition to fetch from (default: "aws"). Valid values: "aws", "aws-iso", "aws-iso-b"'),
  },
  async ({ service, partition }) => {
    const p = partition || 'aws';
    if (!PARTITIONS[p]) {
      return { content: [{ type: 'text', text: `Unknown partition '${p}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}` }], isError: true };
    }
    const manifest = await loadManifest(p);
    const keys = service.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    const errors = [];

    for (const key of keys) {
      const svc = findService(manifest, key);
      if (!svc) { errors.push(`Service "${key}" not found.`); continue; }

      if (svc.key.toLowerCase() === 'ec2enhancement') {
        results.push({
          serviceCode: svc.key,
          serviceName: svc.name,
          configShape: {
            region: 'required AWS region code, e.g. "us-east-1"',
            description: 'recommended short label for this estimate line item',
          },
          fields: [
            { id: 'quantity', label: 'Number of EC2 instances', type: 'numericInput', valueShape: 'string or number', example: '2' },
            { id: 'instanceType', label: 'EC2 instance type', type: 'input', valueShape: 'string', example: 'm6i.large' },
            { id: 'selectedOS', label: 'Operating system', type: 'dropdown', valueShape: 'string', example: 'linux', options: ['linux', 'windows', 'rhel', 'suse'] },
            { id: 'tenancy', label: 'Tenancy', type: 'dropdown', valueShape: 'string', example: 'shared', options: ['shared', 'dedicated', 'host'] },
            { id: 'pricingStrategy', label: 'Pricing strategy', type: 'pricingStrategy', valueShape: 'string or object', example: 'ondemand' },
            { id: 'storageAmount', label: 'EBS storage', type: 'fileSize', valueShape: 'number or {"value":"<number>","unit":"gb|NA"}', example: { value: '30', unit: 'gb|NA' } },
            { id: 'gp3Iops', label: 'gp3 provisioned IOPS', type: 'numericInput', valueShape: 'string or number', example: '3000' },
            { id: 'gp3Throughput', label: 'gp3 throughput MBps', type: 'numericInput', valueShape: 'string or number', example: '125' },
          ],
          recommendedFlow: ['Use ec2Enhancement for EC2.', 'Do not call get_service_fields for EC2.', 'Always include region explicitly.'],
        });
        continue;
      }

      const definition = await fetchServiceDefinition(manifest, svc.key, p);
      if (!definition) { errors.push(`Failed to fetch definition for "${svc.key}".`); continue; }

      const fields = extractInputFields(definition);
      const enriched = await enrichFieldsWithMetadata(definition, fields);
      results.push(buildServiceConfigSchema(svc, enriched));
    }

    const output = errors.length
      ? { services: results, errors }
      : keys.length === 1 ? results[0] : results;
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  }
);

server.tool(
  'create_estimate',
  'Create a new empty estimate. Returns an estimate ID to use with add_service and export_estimate.',
  {
    name: z.string().optional().describe('Name for the estimate (default: "My Estimate")'),
    partition: z.string().optional().describe('AWS partition for this estimate (default: "aws"). Valid values: "aws", "aws-iso", "aws-iso-b"'),
  },
  async ({ name, partition }) => {
    const p = partition || undefined;
    if (p && !PARTITIONS[p]) {
      return { content: [{ type: 'text', text: `Unknown partition '${p}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}` }], isError: true };
    }
    const estimate = new EstimateBuilder(name, p);
    estimates.set(estimate.id, estimate);
    return { content: [{ type: 'text', text: JSON.stringify({ estimate_id: estimate.id, name: estimate.name }) }] };
  }
);

server.tool(
  'add_service',
  `Add one or more AWS services to an estimate. Accepts a single service or a JSON array of services in the "services" parameter.

Field values follow these patterns based on field type:
- numericInput: plain string value, e.g. "1000"
- frequency: object with value and unit, e.g. {"value": "19", "unit": "millionPerMonth"}
- fileSize: object with value and unit. The unit format is "{size}|{frequency}" where size comes from the field's validSizes (gb, tb, mb, etc.) and frequency is usually "NA". Check the field's defaultUnit from get_service_fields. Examples: {"value": "512", "unit": "mb|NA"}, {"value": "1", "unit": "tb|NA"}, {"value": "10", "unit": "gb|NA"}, {"value": "8", "unit": "gb|month"}
- dropdown: string matching one of the option IDs from get_service_fields
- durationInput: object with value and unit, e.g. {"value": "960", "unit": "min"}
- pricingStrategy (Amazon EC2 only): object with model, term, and upfrontPayment keys, e.g. {"model": "computeSavings", "term": "1yr", "upfrontPayment": "None"}. Valid models: "instanceSavings" (EC2 Instance Savings Plans), "computeSavings" (Compute Savings Plans), "ondemand", "spot". For dedicated tenancy only: "reserved" (Standard RI), "convertible" (Convertible RI). Valid terms: "1yr", "3yr". Valid upfrontPayment: "None", "Partial", "All". Shorthand strings also work, e.g. "computeSavings1yrNoUpfront".

Amazon EC2 (ec2Enhancement) has special config fields handled automatically:
- "quantity": number of instances (e.g. "2" for 2 instances). Default: 1.
- "instanceType": instance type (e.g. "g6.12xlarge")
- "selectedOS": operating system. Default: "linux". Options: "linux", "windows", "rhel", "suse", etc.
- "tenancy": "shared" (default), "dedicated", or "host"
- "pricingStrategy": see above
- "storageType": EBS volume type. Default: "Storage General Purpose gp3 GB Mo". Options: "Storage General Purpose gp3 GB Mo" (gp3), "Storage General Purpose GB Mo" (gp2), "Storage Provisioned IOPS GB Mo" (io1), "Storage Provisioned IOPS io2 GB month" (io2), "Storage Throughput Optimized HDD GB Mo" (st1), "Storage Cold HDD GB Mo" (sc1), "Storage Magnetic GB Mo" (magnetic)
- "storageAmount": EBS storage, e.g. {"value": "30", "unit": "gb|NA"}
- "snapshotFrequency": snapshot frequency, e.g. "0" for none
- "gp3Iops": gp3 provisioned IOPS (e.g. "5000"). Auto-sets storageType to gp3 if not specified.
- "gp3Throughput": gp3 provisioned throughput in MBps (e.g. "250"). Auto-sets storageType to gp3 if not specified.
- "iops": io1 provisioned IOPS (e.g. "10000"). Auto-sets storageType to io1 if not specified.
- "iops2": io2 provisioned IOPS (e.g. "20000"). Auto-sets storageType to io2 if not specified.
- "storageAmountIo2": io2 storage amount, e.g. {"value": "100", "unit": "gb|NA"}
Do NOT use get_service_fields for Amazon EC2 — these fields are handled by a custom transform.

IMPORTANT: Before calling this tool, you MUST confirm the desired AWS region with the user if they haven't already specified one. Do NOT assume a default region. Always include "region" in each service config. Use "description" to label what each service entry represents. IMPORTANT: descriptions and group names must NOT contain <, >, or & characters (AWS rejects them).

Config keys are validated against the service definition. Invalid field IDs will be rejected with suggested corrections. Use get_service_fields first to discover valid field IDs for a service.

For batch mode, pass a JSON array in "services":
[{"service":"aWSLambda","instance":"Compute","group":"Prod","config":{...}},{"service":"amazonS3Standard","group":"Prod","config":{...}}]`,
  {
    estimate_id: z.string().describe('Estimate ID from create_estimate'),
    services: z.string().describe('JSON array of service entries. Each entry: {"service":"serviceKey","instance":"optional","group":"optional","config":{...with region, description, and field values}}. Example: [{"service":"aWSLambda","group":"Prod","config":{"region":"eu-west-1","description":"Compute","numberOfRequests":{"value":"19","unit":"millionPerMonth"}}}]'),
  },
  async ({ estimate_id, services: servicesStr }) => {
    const estimate = estimates.get(estimate_id);
    if (!estimate) return { content: [{ type: 'text', text: `Estimate "${estimate_id}" not found.` }], isError: true };

    let entries;
    try {
      entries = JSON.parse(servicesStr);
      if (!Array.isArray(entries)) entries = [entries];
    } catch {
      return { content: [{ type: 'text', text: 'Invalid JSON in services parameter.' }], isError: true };
    }

    const results = await addEntries(estimate, entries);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

server.tool(
  'add_services_structured',
  'Add one or more AWS services to an estimate using structured MCP input. Prefer this over add_service because it avoids hand-serializing nested JSON. Always call get_service_config_schema first for non-EC2 services and always include config.region.',
  {
    estimate_id: z.string().describe('Estimate ID from create_estimate'),
    services: z.array(serviceEntrySchema).describe('Service entries to add. Each entry includes service, optional instance/group, and config with required region.'),
  },
  async ({ estimate_id, services }) => {
    const estimate = estimates.get(estimate_id);
    if (!estimate) return { content: [{ type: 'text', text: `Estimate "${estimate_id}" not found.` }], isError: true };

    const results = await addEntries(estimate, services);
    const hasErrors = results.some(r => r.error);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }], isError: hasErrors || undefined };
  }
);

server.tool(
  'export_estimate',
  'Export an estimate to calculator.aws and get a shareable URL. The link will show the full estimate with AWS-calculated pricing.',
  { estimate_id: z.string().describe('Estimate ID from create_estimate') },
  async ({ estimate_id }) => {
    const estimate = estimates.get(estimate_id);
    if (!estimate) return { content: [{ type: 'text', text: `Estimate "${estimate_id}" not found.` }], isError: true };

    try {
      const result = await estimate.export();
      return { content: [{ type: 'text', text: JSON.stringify({ sharable_url: result.shareableUrl, aws_estimate_id: result.estimateId }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Export failed: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'validate_estimate_cost',
  'Export an estimate, read back AWS Calculator calculated totals, and validate ARR. ARR is totalCost.monthly * 12; upfront costs are reported separately and excluded from ARR.',
  {
    estimate_id: z.string().describe('Estimate ID from create_estimate'),
    expected_annual_recurring: z.number().nonnegative().describe('Expected ARR in USD. Compared against AWS totalCost.monthly * 12.'),
    tolerance_percent: z.number().nonnegative().optional().describe('Allowed percent delta before failing validation (default: 10).'),
    run_visual_check: z.boolean().optional().describe('Optionally open the calculator URL with Playwright and include visual validation evidence (default: false).'),
  },
  async ({ estimate_id, expected_annual_recurring, tolerance_percent, run_visual_check }) => {
    const estimate = estimates.get(estimate_id);
    if (!estimate) return { content: [{ type: 'text', text: `Estimate "${estimate_id}" not found.` }], isError: true };

    try {
      const output = await validateEstimateCostForEstimate(estimate, {
        estimate_id,
        expected_annual_recurring,
        tolerance_percent,
        run_visual_check,
      });
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], isError: output.passed ? undefined : true };
    } catch (err) {
      return { content: [{ type: 'text', text: `Cost validation failed: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'import_estimate',
  'Download an existing AWS Pricing Calculator estimate by URL or ID. Returns the estimate in JSON (raw, for modifications like region swaps) or Markdown (for LLM consumption, summaries, funding recommendations).',
  {
    estimate_id: z.string().describe('Estimate ID or full calculator.aws URL (e.g. "bedb9a10..." or "https://calculator.aws/#/estimate?id=bedb9a10...")'),
    format: z.enum(['json', 'markdown']).optional().describe('Output format: "json" for raw data (default), "markdown" for LLM-friendly summary'),
  },
  async ({ estimate_id, format }) => {
    // Extract ID from URL if needed
    let id = estimate_id;
    const urlMatch = estimate_id.match(/[?&]id=([a-f0-9]+)/);
    if (urlMatch) id = urlMatch[1];

    try {
      const data = await fetchEstimate(id);
      const output = (format === 'markdown')
        ? estimateToMarkdown(data)
        : JSON.stringify(data, null, 2);
      return { content: [{ type: 'text', text: output }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Import failed: ${err.message}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  addEntries,
  validateEstimateCostForEstimate,
};
