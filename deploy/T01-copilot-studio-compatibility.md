# T01 - Copilot Studio MCP compatibility

Verification date: 2026-11-05.

Status: **Partially verified; tenant acceptance deferred to T31 after deployment
and T30 smoke tests**. Do not mark T01 complete or infer deployment approval.

## Approved sandbox scope

On 2026-11-05 the user explicitly accepted REST API with a generated API key
in `x-api-key` and a dedicated usage plan, without a Lambda authorizer or
Secrets Manager. This replaces the previous Authorization/Bearer proposal.
AWS advises against using API keys for authentication or authorization:
this is a sandbox-only exception, not an equivalent authentication mechanism.
The key identifies a shared technical connection, not an end user.
See [AWS usage plan guidance](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html).

## Evidence

| Requirement | Result | Evidence |
| --- | --- | --- |
| Streamable HTTP support | Documented | Microsoft explicitly lists the Streamable transport. |
| API key in a request header | Documented | The MCP onboarding wizard offers API key authentication, Header location, and a configurable header name. |
| Raw API key in `x-api-key`, without a Bearer prefix | Candidate configuration only | Configurable header names are documented; actual tenant/runtime behavior remains to be verified in T31. |
| Key enforcement on `initialize`, `tools/list`, and `tools/call` | Not verified with Copilot Studio | No connected HTTPS endpoint or request-level evidence is available. |
| Key enforcement on `notifications/initialized` and any optional GET/DELETE requests | Not verified with Copilot Studio | Must check requests actually issued by the client, not assume all methods are used. |
| Tenant onboarding UI and protected credential entry | Not verified | Opening the target environment redirects to Microsoft sign-in in the integrated browser. |
| Tenant access through management APIs | Verified, insufficient for T01 | The environments API returned the target Default environment. API authentication does not establish browser authentication, connector permissions, DLP approval, or runtime compatibility. |

The local SDK-to-server smoke test previously verified Streamable HTTP
initialization, discovery of 10 tools, and `get_server_info`. It did not use
Copilot Studio or test its authentication behavior and is not evidence that
the intended connection works.

Legacy HTTP+SSE transport and an SSE response to a Streamable HTTP request are
not the same thing. Microsoft's deprecation of the former does not prove that
all Streamable HTTP responses will be ordinary JSON.

## Candidate configuration to verify in the tenant

1. Open the agent's **Tools > Add a tool > New tool > Model Context Protocol**.
2. Provide the deployed HTTPS MCP endpoint, including stage path and `/mcp`.
   AWS Calculator CDN URLs are not MCP endpoints.
3. Select **API key**, location **Header**, header name **x-api-key**.
4. At **Create a new connection**, an authorized operator enters the raw
   generated API key, without a Bearer prefix, into the protected credential
   field. Do not put that value in the server
   URL, tool arguments, agent instructions, repository, chat, or logs.
5. Verify in the actual UI that this is a protected connection credential,
   that the header is accepted, and that no undocumented prefix is added.
   The documented generic header option alone is not proof of these points.

API key is the connector's credential configuration mode. On AWS, the usage
plan/key check is not authentication or authorization. This proposal does
not introduce OAuth or JWT validation. Verify key enforcement on every
application method and ensure there is no alternate unkeyed endpoint.

## Remaining acceptance checks

- Complete browser sign-in to the intended tenant and inspect the actual MCP
  onboarding wizard. Do not save an incomplete connector or dummy credential.
- Confirm connector creation/use permissions and any applicable data policies;
  do not infer them from successful Dataverse access.
- Use the deployed REST API after T29-T30; no separate test endpoint is required.
  Deployment, exposing a local service, or granting a third party access
  requires separate approval. No deployment was performed for T01.
- Exercise `initialize`, the initialized notification if issued, `tools/list`,
  and a non-mutating `tools/call`, such as `get_server_info`, from Copilot Studio.
- For each issued request, correlate the API Gateway request ID with the
  operation and response, and confirm it used a method requiring the valid
  key. API Gateway performs key validation; do not add key retrieval or
  comparison to the application Lambda. Record only request ID, method,
  JSON-RPC operation, header-presence boolean and response status. Never
  record the key, full header, fragments or credential-derived fingerprints.
- Verify wrong/missing credentials are rejected. Determine whether initial
  discovery or retry behavior causes unkeyed requests, and distinguish
  a rejected probe from a successful operation with a valid key.
- Record content types, MCP protocol headers, and actual optional GET/DELETE
  behavior. Do not claim coverage of requests that were not observed.

If the header is rejected, transformed, omitted on an operation, or cannot be
entered securely, leave T01 blocked and use T02 to request a design decision.
Do not silently substitute OAuth or another header.

- Verify rotation and old-key rejection in T33; account for API Gateway
  propagation delays. A successful T31 does not waive the sandbox exception.

## Sources

Primary sources, consulted on 2026-11-05:

- [Microsoft: Connect your agent to an existing MCP server](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent)
  - **Supported transports**: Streamable transport; legacy SSE support removed
    after August 2025.
  - **Configure API key authentication**: Header/Query locations and a
    configurable parameter name.
  - **Create a new connection and add the MCP server to your agent**:
    connection creation is distinct from server registration.
  - **MCP servers and data policies**: MCP connectivity relies on Power
    Platform connectors and is subject to connector data policies.
- [Microsoft: Create a custom connector from scratch](https://learn.microsoft.com/en-us/connectors/custom-connectors/define-blank)
  - **Step 2: Specify authentication type**: API key parameter label, name, and
    location. This is general connector documentation, not request-level proof
    for Copilot Studio's MCP client.
