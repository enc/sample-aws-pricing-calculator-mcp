# AWS Pricing Calculator MCP

[Model Context Protocol](https://modelcontextprotocol.io) server that programmatically builds AWS pricing estimates and generates shareable [calculator.aws](https://calculator.aws) URLs. Supports all 436+ AWS services via live service definitions from the AWS Calculator CDN.

## Quick Start

```bash
npm install
node mcp-server.js
```

Or use the pre-built bundle:

```bash
node dist/mcp-server.js
```

The server communicates over stdio using the MCP protocol — it's designed to be used by MCP-compatible clients (e.g. Claude, Kiro), not called directly via HTTP.

## MCP Tools

| Tool | Description |
|---|---|
| `search_services` | Search AWS services by name or key. Supports comma-separated queries. |
| `get_service_fields` | Get input field IDs, types, labels, and valid options for one or more services. |
| `create_estimate` | Create a new empty estimate. Returns an estimate ID. |
| `add_service` | Add one or more services to an estimate with config values. Supports batch mode. |
| `export_estimate` | Export an estimate to calculator.aws and get a shareable URL. |

## Project Structure

```
mcp-server.js                # Entry point — stdio MCP server
lib/
  aws-client.js              # AWS manifest loading, service definitions, field extraction, save API
  estimate-builder.js         # Estimate builder with AWS payload generation and export
  ec2.js                     # EC2 config transformation (agent-friendly → calculator format)
test/
  aws-client.test.js         # Tests for AWS client
  ec2.test.js                # Tests for EC2 transform
  estimate-builder.test.js   # Tests for estimate builder
```

## Build

```bash
npm run build
```

Produces two artifacts in `dist/`:

- `dist/mcp-server.js` — single-file esbuild bundle (minified, CJS, Node platform)
- `dist/aws-calculator.zip` — source archive containing `mcp-server.js`, `lib/*.js`, and `package.json`

## Tests

```bash
npm test
```

## How It Works

### Service Discovery

On first use, the server fetches the AWS Calculator manifest from CloudFront, which contains all 436+ services with their keys, names, and definition URLs. Service definitions are fetched on demand and cached. The `get_service_fields` tool parses these definitions to extract input field IDs, types, labels, and valid options into a flat, usable format.

### Estimate Building

`EstimateBuilder` holds services and groups in memory. When you add a service via `add_service`, config is stored as-is using the AWS field IDs. Services can be organized into named groups, and multiple instances of the same service are supported via composite keys (e.g. `aWSLambda:Compute`).

### EC2 Handling

EC2 uses a custom config transform (`lib/ec2.js`) that converts agent-friendly fields (instance type, OS, pricing strategy) into the `ec2Enhancement` format the calculator expects. This includes support for On-Demand, Savings Plans, Reserved Instances, and Spot pricing.

### Export to calculator.aws

When `export_estimate` is called, the builder:

1. Resolves each service name against the manifest
2. Fetches the service definition to get the correct `version`, `serviceCode`, and template ID
3. Maps config keys to `calculationComponents` in the AWS payload format
4. POSTs the assembled payload to the AWS Calculator save API
5. Returns the shareable `calculator.aws` URL

AWS recalculates the actual costs when someone opens the link.

## Environment Variables

All optional:

| Variable | Default | Purpose |
|---|---|---|
| `AWS_MANIFEST_URL` | CloudFront manifest URL | AWS service catalog |
| `AWS_SAVE_URL` | CloudFront save URL | Estimate persistence |

## Caveats

- The CloudFront save/manifest APIs are undocumented and may change without notice.
- Callers must use the correct AWS field IDs — discover them via `get_service_fields`.
- Estimates live in memory and don't persist across restarts.
- No local cost calculation — pricing is computed by AWS when viewing the shareable link.
