# AWS Pricing Calculator MCP Server

[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that programmatically creates, reads, updates [AWS Pricing Calculator](https://calculator.aws/#/estimate) estimates through natural language.

## Key Features

- **Creating Estimates**: Supports all AWS services via live service definitions from the AWS Calculator CDN
- **Importing Estimates**: Download existing estimates by URL/ID as JSON (for modifications e.g. swap AWS regions) or Markdown (for LLM analysis)
- **Batch Processing**: Create estimates from Excel/CSV files via LLM-assisted parsing
- **No AWS Credentials Required**: Works without AWS account access

## Example

Prompt:
> Create an AWS Pricing Calculator estimate for a common Wordpress environment on AWS (Dev, Quality, Production).

Output:
![](example1.png)

## Quick Start

Requires [Node.js®](https://nodejs.org/en/download).

```bash
git clone https://github.com/aws-samples/sample-aws-pricing-calculator-mcp.git
cd sample-aws-pricing-calculator-mcp
npm install
npm run build
```

The server communicates over stdio using the MCP protocol — it's designed to be used by MCP-compatible clients (e.g. Claude, Kiro), not called directly via HTTP.

### MCP Client Configuration

Add to your MCP client config (e.g. `~/.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "aws-pricing-calculator-mcp-server": {
      "command": "node",
      "args": ["/path/to/sample-aws-pricing-calculator-mcp/dist/mcp-server.js"]
    }
  }
}
```

## MCP Tools

| Tool | Description |
|---|---|
| `search_services` | Search AWS services by name or key. Supports comma-separated queries. |
| `get_service_fields` | Get input field IDs, types, labels, and valid options for one or more services. |
| `create_estimate` | Create a new empty estimate. Returns an estimate ID. |
| `add_service` | Add one or more services to an estimate with config values. Supports batch mode. |
| `export_estimate` | Export an estimate to calculator.aws and get a shareable URL. |
| `import_estimate` | Download an existing estimate by URL or ID. Returns JSON (raw) or Markdown. |

## Project Structure

```
mcp-server.js                # Entry point — stdio MCP server
lib/
  aws-client.js              # AWS manifest loading, service definitions, field extraction, save API
  estimate-builder.js         # Estimate builder with AWS payload generation and export
  ec2.js                     # EC2 config transformation (agent-friendly -> calculator format)
test/
  aws-client.test.js         # Tests for AWS client
  ec2.test.js                # Tests for EC2 transform
  estimate-builder.test.js   # Tests for estimate builder
  integration.test.js        # Integration tests
  validation.test.js         # Config validation tests
```

## Build

```bash
npm run build
```

Produces `dist/mcp-server.js` — a single-file esbuild bundle (minified, CJS, Node platform).

## Tests

```bash
npm test
```

## Architecture

```
┌─────────────────┐       stdio        ┌──────────────────────────────────────┐
│   MCP Client    │◄──────────────────►│         MCP Server                   │
│ (Kiro, Claude,  │   JSON-RPC over    │                                      │
│  Cursor, etc.)  │   stdin/stdout     │  mcp-server.js (entry point)         │
└─────────────────┘                    │    ├── lib/aws-client.js             │
                                       │    ├── lib/estimate-builder.js       │
                                       │    └── lib/ec2.js                    │
                                       └──────────┬───────────┬──────────────┘
                                                  │           │
                                        HTTPS GET │           │ HTTPS POST
                                                  ▼           ▼
                                       ┌──────────────┐  ┌──────────────────┐
                                       │ CloudFront   │  │ AWS Calculator   │
                                       │ CDN          │  │ Save API         │
                                       │              │  │                  │
                                       │ • manifest   │  │ POST /v2/saveAs  │
                                       │ • service    │  │ → returns        │
                                       │   definitions│  │   shareable URL  │
                                       └──────────────┘  └──────────────────┘
```

- The MCP server runs as a **local child process** spawned by the MCP client. It communicates exclusively over stdio — it is not network-accessible.
- All outbound requests are **HTTPS** to public, unauthenticated AWS CloudFront distributions. No AWS credentials are required or used.
- Estimate data is held **in memory only** and is lost when the process exits. No data is persisted to disk.

## How It Works

### Service Discovery

On first use, the server fetches the AWS Calculator manifest from CloudFront, which contains all 436+ services with their keys, names, and definition URLs. Service definitions are fetched on demand and cached. The `get_service_fields` tool parses these definitions to extract input field IDs, types, labels, and valid options into a flat, usable format.

### Estimate Building

`EstimateBuilder` holds services and groups in memory. When you add a service via `add_service`, config is stored as-is using the AWS field IDs. Services can be organized into named groups, and multiple instances of the same service are supported via composite keys (e.g. `aWSLambda:Compute`).

### EC2 Handling

EC2 uses a custom config transform (`lib/ec2.js`) that converts agent-friendly fields (instance type, OS, pricing strategy) into the `ec2Enhancement` format the calculator expects. This includes support for On-Demand, Savings Plans, Reserved Instances, and Spot pricing.

### Partition Support

The server supports three AWS partitions:
- `aws` — standard commercial regions
- `aws-iso` — US ISO East/West
- `aws-iso-b` — US ISOB East

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

## Known Issues

- The CloudFront save/manifest APIs are undocumented and may change without notice.
- Callers must use the correct AWS field IDs — discover them via `get_service_fields`.
- Estimates live in memory and don't persist across restarts.
- No local cost calculation — pricing is computed by AWS when viewing the shareable link -> Make sure to press `Update estimate` to reflect latest pricing.
- Only https://calculator.aws/ supported for now

## Security

This is sample code intended for educational purposes. You should work with your security and legal teams to meet your organizational security, regulatory, and compliance requirements before deployment.

### Security Model

This MCP server is a **local tool provider** — it runs as a child process of an MCP client and is not network-accessible. It has no authentication or authorization layer; access control is the responsibility of the MCP client that spawns it.

The server does not handle AWS credentials, customer data, or PII. It processes only pricing configuration parameters (e.g., region, instance type, request counts) provided by the MCP client.

These are the same public, unauthenticated endpoints used by the [calculator.aws](https://calculator.aws) website. No AWS credentials are transmitted.

### Input Validation and Sanitization

- All MCP tool inputs are validated using [Zod](https://zod.dev/) schemas before processing.
- User-provided descriptions and group names are sanitized to remove `<`, `>`, and `&` characters before inclusion in API payloads, preventing HTML/XML injection in the calculator frontend.
- Service configuration keys are validated against AWS service definitions with typo detection (Levenshtein distance), rejecting invalid field IDs before they reach the API.

### Data Handling

- Estimate data is held **in memory only** for the lifetime of the process. No data is written to disk or persisted across restarts.
- The data consists of pricing configuration (region codes, service parameters, instance types) — not secrets, credentials, or personally identifiable information.
- Shareable URLs generated by the export contain only an opaque estimate ID. The estimate content is stored by AWS, not by this server.

### Reporting Security Issues

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for information on reporting security issues.

## AWS MCP Servers Comparison: Pricing & Cost Management

| | **AWS Pricing Calculator MCP (This)** | **[AWS Billing & Cost Management MCP](https://github.com/awslabs/mcp#-cost--operations)** | **[AWS Pricing MCP](https://github.com/awslabs/mcp#-cost--operations)** |
|---|---|---|---|
| **Purpose** | Build shareable cost estimates for new workloads | Analyze historical spend & optimize existing costs | Query real-time pricing data from Price List API |
| **Data Source** | AWS Pricing Calculator (calculator.aws) | Cost Explorer, Cost Optimization Hub, Compute Optimizer, Savings Plans, Budgets, Storage Lens | AWS Price List Bulk API |
| **Output** | Shareable calculator.aws URL with full estimate | Natural language cost insights, savings recommendations | Raw pricing data, cost reports (markdown/CSV) |
| **Use Case** | "What will this new architecture cost?" | "Where am I overspending today?" | "What's the per-unit price of X?" |
| **Scope** | Forward-looking estimates | Historical & current spend | Current catalog pricing |
| **AWS Credentials** | Not required (uses public calculator API) | Required (reads your billing data) | Required (`pricing:*` permissions) |

TL;DR: Use the Pricing Calculator MCP to build estimates for proposals, the Billing & Cost Management MCP to analyze/optimize what you're already spending, and the Pricing MCP for granular unit-price lookups and IaC cost analysis.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.

## Disclaimer

Before using an MCP Server, you should consider conducting your own independent assessment to ensure that your use would comply with your own specific security and quality control practices and standards, as well as the laws, rules, and regulations that govern you and your content.