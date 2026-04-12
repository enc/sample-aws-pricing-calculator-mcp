# Local AWS Calculator

API server that programmatically builds AWS pricing estimates and generates shareable [calculator.aws](https://calculator.aws) URLs. Supports all 436+ AWS services via live service definitions from the AWS Calculator CDN.

## Quick Start

```bash
npm install
npm start          # listens on :3001
npm run build      # bundle MCP server + zip source into dist/
```

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Server port |
| `AWS_MANIFEST_URL` | CloudFront manifest URL | AWS service catalog |
| `AWS_SAVE_URL` | CloudFront save URL | Estimate persistence |

## Usage

```bash
# 1. Find a service
curl -s http://localhost:3001/services?q=lambda | jq .
# → [{"key": "aWSLambda", "name": "AWS Lambda"}, ...]

# 2. Discover its fields
curl -s http://localhost:3001/services/aWSLambda/fields | jq .
# → { serviceCode, serviceName, fields: [{ id, type, label, options? }, ...] }

# 3. Create an estimate
ID=$(curl -s -X POST http://localhost:3001/estimates/my_estimate | jq -r .estimation_id)

# 4. Add services using the discovered field IDs
curl -s -X PUT "http://localhost:3001/estimates/$ID/services/aWSLambda/Compute?group=Prod" \
  -H 'Content-Type: application/json' \
  -d '{
    "region": "eu-west-1",
    "description": "Compute",
    "selectArchitectureRequests": "2",
    "numberOfRequests": {"value": "19", "unit": "millionPerMonth"},
    "durationOfEachRequest": "1000",
    "sizeOfMemoryAllocated": {"value": "512", "unit": "mb|NA"},
    "storageAmountEphemeral": {"value": "512", "unit": "mb|NA"}
  }'

# 5. Add multiple instances of the same service
curl -s -X PUT "http://localhost:3001/estimates/$ID/services/amazonApiGateway/GetRecs?group=Prod" \
  -H 'Content-Type: application/json' \
  -d '{"region": "eu-west-1", "description": "GetRecommendations", "RESTMult": "1000000", "numberOfRESTRequests": {"value": "4.5", "unit": "perMonth"}, "cacheSize": "[ZERO_COST]"}'

# 6. Generate shareable calculator.aws URL
curl -s "http://localhost:3001/estimates/$ID?type=sharable_url" | jq .
# → { "sharable_url": "https://calculator.aws/#/estimate?id=...", "aws_estimate_id": "..." }
```

See `create-estimate.sh` for a full example with 24 services across Prod and Dev groups.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/services?q=<query>` | Search services by name or key |
| `GET` | `/services/:service/fields` | Input fields with IDs, types, labels, and valid options |
| `GET` | `/services/:service/definition` | Raw service definition from AWS CDN |
| `POST` | `/estimates/my_estimate` | Create a new estimate; returns `{ estimation_id }` |
| `PUT` | `/estimates/:id/services/:service/:instance?` | Add a service to an estimate. Use `?group=` for grouping, `:instance` for multiple entries of the same service |
| `GET` | `/estimates/:id` | Get estimate with all services and groups |
| `GET` | `/estimates/:id?type=sharable_url` | Export to calculator.aws and return shareable URL |
| `GET` | `/view?id=:id` | HTML estimate viewer |

## Project Structure

```
server.js                    # Entry point — app.listen()
app.js                       # Express routes (thin HTTP layer)
lib/
  aws-client.js              # AWS manifest, service definitions, save API, field extraction
  estimate-builder.js        # Estimate builder with AWS payload generation and export
public/
  estimate-viewer.html       # Browser-based estimate viewer
```

## How It Works

### Service Discovery

On first request, the server fetches the AWS Calculator manifest from CloudFront, which contains all 436+ services with their keys, names, and definition URLs. Service definitions are fetched on demand and cached. The `/services/:service/fields` endpoint parses these definitions to extract input field IDs, types, labels, and valid options into a flat, usable format.

### Estimate Building

`EstimateBuilder` holds services and groups in memory. When you add a service, config is stored as-is using the AWS field IDs. Services can be organized into named groups via the `?group=` query parameter, and multiple instances of the same service are supported via the `:instance` URL parameter (stored as `service:instance` composite keys).

### Export to calculator.aws

When a shareable URL is requested, the builder:

1. Resolves each service name against the manifest (exact match, then substring fallback)
2. Fetches the service definition to get the correct `version`, `serviceCode`, and template ID
3. Maps config keys to `calculationComponents` in the AWS payload format
4. POSTs the assembled payload to the AWS Calculator save API
5. Returns the shareable `calculator.aws` URL

AWS recalculates the actual costs when someone opens the link.

## MCP Server

The project includes a [Model Context Protocol](https://modelcontextprotocol.io) server (`mcp-server.js`) that exposes the calculator functionality as MCP tools. Run it with:

```bash
node mcp-server.js
```

Or use the pre-built bundle:

```bash
node dist/mcp-server.js
```

## Build

```bash
npm run build
```

This produces two artifacts in `dist/`:

- `dist/mcp-server.js` — single-file esbuild bundle (minified, CJS, Node platform)
- `dist/aws-calculator.zip` — source archive containing `mcp-server.js`, `lib/*.js`, and `package.json`

## Caveats

- The CloudFront save/manifest APIs are undocumented and may change without notice.
- Callers must use the correct AWS field IDs — discover them via `/services/:service/fields`.
- Estimates live in memory and don't persist across restarts.
- No local cost calculation — pricing is computed by AWS when viewing the shareable link.
