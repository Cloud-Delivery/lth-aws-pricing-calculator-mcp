# Lutech serverless deployment workflow

The workspace provides two specialized agents and a deployment skill:

- [aws-serverless-deployer](../.github/agents/aws-serverless-deployer.agent.md)
  prepares, validates and deploys the AWS service.
- [copilot-studio-builder](../.github/agents/copilot-studio-builder.agent.md)
  builds and tests the Copilot Studio agent and MCP connection.
- [aws-serverless-deploy](../.github/skills/aws-serverless-deploy/SKILL.md)
  guides compatibility, costing, implementation, deployment and acceptance.

Reload the client if customizations are not visible. `aws-mcp` uses profile
`lutechlab-sandbox`; authenticated IaC and Pricing tools must use the same
credential context. Pass the approved target region `eu-south-1` explicitly.

All deployment implementation and documentation belong under `deploy/`.
Upstream application files in the Git submodule remain unmodified.
On 2026-11-05 the user approved a deployment-only DynamoDB store override
and its tests: strong reads and version-conditional writes only.
Design/cost review, synthesis, compliance checks and approved diff precede
resource changes. Installing customizations creates no stack or AWS resources.

## Upstream submodule and overrides

The source is [`sample-aws-pricing-calculator-mcp`](../sample-aws-pricing-calculator-mcp/),
an upstream `main` submodule initially pinned to
`36e68261a40703bad1978556dfeddf338a658981` (1.3.4).
Initialize it with `git submodule update --init --recursive` from the root.
An uninitialized submodule fails packaging with an explicit diagnostic.

[`scripts/package.cjs`](./scripts/package.cjs) copies source and catalog to
`.staging`, applies [`overrides`](./overrides/), and bundles the Lambda
artifact using only deployment dependencies. CDK consumes that artifact.
It never writes into the submodule or uses the upstream prebuilt bundle.

Override files mirror source-relative paths. Each entry in
[`overrides/manifest.json`](./overrides/manifest.json) records the SHA-256 of
the original UTF-8 upstream file, with CRLF normalized to LF.
[`scripts/overrides.cjs`](./scripts/overrides.cjs) verifies that baseline
before replacing the staging file. Missing files, invalid paths and changed
baselines fail the build; an upstream upgrade requires explicit review.
After reviewing the upstream diff, adapt the replacement and tests before
updating the baseline. Full-file overrides intentionally do not merge
upstream changes automatically.

The current override replaces only
[`lib/store/estimate-store-dynamodb.js`](./overrides/lib/store/estimate-store-dynamodb.js).
Its relative imports resolve against unchanged upstream files in staging.
Tests verify baseline protection, staging replacement, store-factory wiring,
concurrency behavior and an unchanged submodule worktree.

From the repository root:

```powershell
npm --prefix deploy ci
npm --prefix deploy typecheck
npm --prefix deploy test
```

For deliberate submodule upgrades, follow
[the root workflow](../README_LUTECH.md#repository-layout-and-upstream-upgrades).
Never edit the submodule, including for deployment fixes.

Migration validation (2026-11-06): deployment build and all 41 deployment
tests passed, including a subprocess running the seven unchanged upstream
memory-store tests. Local CDK synthesis of `LthAwsPricingMcpStack` passed
without AWS calls. The submodule worktree remained clean.
Dependency audit reports two moderate findings (`aws-cdk-lib` and
`minimatch`); no automatic dependency or security-design changes were made.
These local checks are not deployment or real DynamoDB acceptance.

## Approved sandbox direction

Follow [the implementation TODO](./TODO.md), including its handoff prompt.

[High-level AWS architecture (draw.io)](./aws-pricing-mcp-sandbox.drawio):
one `Architettura` page using official AWS4 icons. It depicts the planned
sandbox, not a deployed stack; client acceptance, adapter compatibility,
concurrent updates and costs remain subject to validation and T10 approval.

The decision on 2026-11-05 is REST API with generated `x-api-key` and a
dedicated usage plan, Lambda and DynamoDB, in account `695076071513`,
region `eu-south-1`, stack `LthAwsPricingMcpStack`.
Chromium is excluded. Expected traffic is below 1000 requests/day.
CloudWatch Logs retention is 7 days for all service log groups (Lambda and
API Gateway), explicitly configured in CDK and asserted in template tests.
No Lambda authorizer or Secrets Manager is included.

**Explicit sandbox-only exception:** AWS advises against API keys for
authentication or authorization. The user accepted key-only usage controls
for this sandbox, not authentication equivalent to an authorizer.
The key is shared, with no per-user isolation. Quotas and throttling are
best-effort, not a guaranteed spending cap. Before another environment or
production use, obtain a new security design decision.
[AWS guidance](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html).

The Copilot Studio wizard and runtime acceptance are T31, after deployment
and T30 endpoint smoke tests. See [the client checklist](./T01-copilot-studio-compatibility.md).
Design/cost approval (T10) and separate approvals for bootstrap, artifact
publication, key creation and deployment are still required.
Never expose key values in source, logs, chat or CDK outputs.

## Preliminary compatibility findings

Initial read-only inspection on 2026-11-05; updated task status and evidence
are recorded in the design review below:

- [The entrypoint](../sample-aws-pricing-calculator-mcp/mcp-server.js) starts Express on `HOST`/`PORT` when
  `MCP_TRANSPORT=http`; it does not export a production Lambda handler.
  A deployment adapter must forward requests to the local listener.
  POST `/mcp` uses stateless Streamable HTTP; GET/DELETE return 405.
- A new transport closes the previous one for each request. Test the
  adapter's invocation lifecycle and process reuse; do not assume global
  reserved concurrency of 1 is required.
- [The upstream DynamoDB store](../sample-aws-pricing-calculator-mcp/lib/store/estimate-store-dynamodb.js) uses string
  partition key `id`, JSON string `snapshot` and optional numeric `expiresAt`.
  The initial review found eventual reads and unconditional writes.
  The approved store correction below adds strong reads and conditional
  versions; persistence and isolation still require deployment acceptance.
  The DynamoDB item-size limit also bounds estimate size.
- [The upstream manifest](../sample-aws-pricing-calculator-mcp/package.json) declares DynamoDB SDK packages as optional
  peers. Package them explicitly alongside the server and catalog.
- REST API supports
  [Lambda response streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-streaming-lambda-configure.html).
  This is not proof of adapter, `eu-south-1` or Copilot Studio compatibility:
  validate availability, framing, buffering and effective timeouts in T06.
- The earlier chat cost figures were preliminary, not verified regional
  estimates. The T09 table below supersedes them.

## Design review T05-T10 (2026-11-05)

Status: **design and cost assumptions approved for code generation on
2026-11-05; deployment not approved**. The implementation below follows this
design. Local checks do not replace AWS and Copilot Studio acceptance.
STS reconfirmed account `695076071513` with `lutechlab-sandbox` in `eu-south-1`.

### Proposed execution model

- Regional REST API, stage `sandbox`, explicit POST/GET/DELETE `/mcp` methods,
  all requiring a generated key associated with the dedicated usage plan.
  No catch-all unkeyed method, Function URL, extra stage or VPC/NAT.
  Preserve 405 for keyed GET/DELETE and 403 for invalid/missing keys.
- Node.js Lambda with an isolated, long-lived child process per execution
  environment running the unchanged upstream Express listener on loopback.
  A TypeScript handler under `deploy/` performs REST-event translation and
  forwards the request to that listener. This avoids depending on a nonexistent
  exported Express app or production Lambda handler.
- Start with a buffered Lambda proxy integration: preserve JSON-RPC, SSE
  framing and content type in the completed response. This is **not live
  streaming**. Proposed total handler deadline 25 seconds, Lambda timeout
  28 seconds and API integration timeout 29 seconds. Deadline includes startup.
  On deadline, terminate the child before returning an explicit error; do not
  leave a timed-out estimate operation running in the background.
  Tools that cannot complete within this envelope require a design decision.
- Proposed 1024 MB memory, x86_64, supported Node.js 24 runtime and reserved
  concurrency 5; no provisioned concurrency. Confirm startup/package size and
  service quota before implementation acceptance. One invocation per standard
  execution environment serializes that process, not updates across environments.
- Strip credential headers before forwarding to the child; disable upstream
  tracing (`TRACE=off`). Emit only bounded operational fields, not event bodies,
  credential values or complete estimates. CloudWatch log retention is 7 days.
- Package source, catalog and explicit DynamoDB SDK dependencies from staging
  under `deploy/`; do not build over root artifacts. No Chromium or ECR required.
- The deployment proxy must enforce an explicit tool list: remove
  `get_estimate_cost` from discovery and `get_server_info`, reject direct calls
  with an explicit MCP error, and cover these surfaces with tests.
  This changes the deployment protocol surface, not upstream files.
  Build/export remain external-effect tools requiring operator approval.

AWS Knowledge confirms REST API supports both buffered and streamed responses;
CDK IaC searches confirmed `LambdaIntegration.responseTransferMode`,
`apiKeyRequired` and usage-plan constructs. Streaming is not assumed merely
because the upstream response content type is SSE. The initial proposal stays
within the default buffered timeout, without a quota increase.
If client testing requires true streaming, reassess regional availability,
adapter framing, costs and timeouts before changing this choice.

Sources:

- [API Gateway response transfer modes](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)
- [CDK LambdaIntegrationOptions](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigateway.LambdaIntegrationOptions.html)
- [API Gateway integration limits](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html)
- [Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)

### Approved persistence correction (T08)

Use a DynamoDB Standard on-demand table with partition key `id` (String),
`snapshot` (JSON String), encryption, retention on stack deletion/replacement,
and proposed PITR. No TTL initially, so estimates do not expire implicitly.
Keep snapshots below the DynamoDB 400 KiB item limit, including attributes.

The original store used eventual reads and unconditional whole-snapshot puts.
A deterministic local fixture confirmed two readers of the same snapshot can
write sequentially and the stale second snapshot replaces the first.
Reserved concurrency 1 alone does not correct eventual reads.
Do not claim concurrency safety from a successful round-trip test.

User approval on 2026-11-05 authorized the narrow correction, now isolated in
[the deployment override](./overrides/lib/store/estimate-store-dynamodb.js) and
[its tests](./test/estimate-store-dynamodb.test.cjs). The upstream submodule
is unchanged; the correction is applied only during deployment packaging.

- `GetItem` requests `ConsistentRead: true`.
- New rows have numeric `version=1`; creation requires the ID not to exist.
- Each hydrated instance carries its read version in a store-owned WeakMap,
  outside the JSON snapshot. Update requires the expected version and increments
  it only after a successful write. A detached snapshot cannot overwrite a row:
  reload it with the same store before applying updates.
- Existing rows without `version` are upgraded to version 1 on their first
  successful update, requiring the row to exist and still have no version.
  Concurrent legacy upgrades conflict; no table migration is required.
- Stale or deleted snapshots raise `EstimateConflictError`, with the original
  conditional failure as cause and an explicit reload/reapply message.
  No automatic retry silently overwrites or merges changes.
- Invalid stored versions, overflow and ID changes are rejected explicitly.
  Operational SDK errors are rethrown, and failed writes do not advance metadata.
  If a transport error leaves a write outcome unknown, reload before retrying.
- JSON exports, memory-store behavior, TTL configuration and delete-by-ID
  behavior are unchanged. Deletion is still unconditional, not version-checked.

Rollout requirement: all writers to the table must use the corrected store.
Old processes can still issue unconditional writes and remove the version;
drain/stop them before concurrent use. Do not reuse deleted estimate UUIDs.
Validate real DynamoDB concurrency and cold-start persistence in T25/T32;
local mocks are not AWS acceptance.

### Measured local evidence

Using the current source on Windows and an in-memory store, a temporary local
HTTP probe verified these exact responses; it created no AWS resources:

| Operation | HTTP | Content type | Observed duration |
| --- | --- | --- | --- |
| Listener startup | n/a | n/a | 6464 ms |
| `initialize` | 200 | `text/event-stream` | 102 ms |
| `notifications/initialized` | 202 | empty response | 7 ms |
| `tools/list` | 200 | `text/event-stream` | 8 ms |
| `tools/call` (`get_server_info`) | 200 | `text/event-stream` | 9 ms |
| GET / DELETE `/mcp` | 405 | n/a | not benchmarked |

JSON-RPC IDs and absence of protocol errors were asserted. Discovery still
advertises 10 upstream tools, including the Chromium tool, so deployment
filtering remains to implement. These measurements are **not** Linux/Lambda
cold-start timings, API Gateway acceptance, DynamoDB persistence or Copilot
Studio compatibility.

Initial targeted tests: 8 passed before the correction; the fixture confirmed
missing `ConsistentRead` and `ConditionExpression`. Regression results after the
approved change: the DynamoDB and memory-store regression tests passed
28 tests, 0 failed before the submodule migration. These regressions are now
included in `npm --prefix deploy test`. Coverage includes cross-store
conflicts, legacy upgrades, duplicate creation, deleted rows, overflow, invalid
versions, failed writes, TTL and unchanged memory-store behavior.
No live DynamoDB write was performed.

### Regional monthly cost estimate (T09)

Pricing MCP was queried on 2026-11-05 for Milan `eu-south-1`; the global
transfer catalog was filtered by `fromLocation=EU (Milan)` and
`toLocation=External`. The Pricing SDK initially failed to refresh SSO,
while AWS CLI worked. The query was retried with CLI-exported temporary
credentials held only in the child environment; STS verified the same sandbox
account. No credentials were printed or saved.

Assumptions: 30 days, 30000 API/Lambda requests, 1 GB Lambda memory,
2 seconds mean billed duration including startup (10-second sensitivity below);
30000 reads of 20 KiB at strong consistency (5 RRUs/read),
10000 writes of 20 KiB (20 WRUs/write), 1 GB stored estimates and PITR,
0.15 GB logs/month with 7-day retention, 1 GB retained S3 CDK artifacts,
1000 artifact PUT and 1000 GET requests, 0.6 GB outbound internet data.
No Free Tier, credits or free transfer/storage allowances are assumed;
positive paid-tier storage/transfer rates are used conservatively.

| Component | Queried Milan rate | Monthly USD |
| --- | --- | ---: |
| REST API | 3.68 / million requests | 0.110400 |
| Lambda x86 duration | 0.0000195172 / GB-second | 1.171032 |
| Lambda requests | 0.23 / million | 0.006900 |
| DynamoDB on-demand reads | 0.1485 / million RRUs | 0.022275 |
| DynamoDB on-demand writes | 0.74 / million WRUs | 0.148000 |
| DynamoDB storage, paid tier | 0.29715 / GB-month | 0.297150 |
| DynamoDB PITR | 0.231 / GB-month | 0.231000 |
| Logs ingestion | 0.60 / GB | 0.090000 |
| Logs storage (0.035 GB average) | 0.032 / GB-month | 0.001120 |
| S3 Standard artifact storage | 0.024 / GB-month | 0.024000 |
| S3 artifact PUT / GET | 0.0053 / 1000 PUT; 0.0004 / 1000 GET | 0.005700 |
| Internet transfer, paid first tier | 0.09 / GB | 0.054000 |
| **Total at 2 seconds average** | | **2.161577** |
| **Total at 10 seconds average** | | **6.845705** |

Budgetary range: **about USD 2-7/month**, not a fixed cap. The 2-second
scenario is an assumption, not the measured end-to-end Lambda average.
No authorizer, Secrets Manager, VPC/NAT, ECR, provisioned concurrency or
custom metrics/alarms are included. Default service metrics are used.
Taxes, Logs Insights scans, extra backups, artifact growth, streaming and
larger responses/estimates are excluded and may increase costs.
Bootstrap S3 storage/requests are included as above, but existing shared
bootstrap usage and future artifact retention must be checked before deployment.

Sources: AWS Price List API via Pricing MCP (`get_pricing`), service codes
`AmazonApiGateway`, `AWSLambda`, `AmazonDynamoDB`, `AmazonCloudWatch`,
`AmazonS3`, `AWSDataTransfer`.
Relevant usage types include `EUS1-ApiGatewayRequest`,
`EUS1-Lambda-GB-Second`, `EUS1-Request`, `EUS1-ReadRequestUnits`,
`EUS1-WriteRequestUnits`, `EUS1-DataProcessing-Bytes`,
`EUS1-TimedStorage-ByteHrs`, `EUS1-TimedPITRStorage-ByteHrs`,
`EUS1-Requests-Tier1`, `EUS1-Requests-Tier2`, `EUS1-DataTransfer-Out-Bytes`.
Rates are estimates, not a billing guarantee; re-query before deployment.

**Next gate:** complete deployment validation T27, inspect the target-account
diff and approve AWS changes in T28. Runtime/AWS acceptance remains pending.

## CDK implementation and operator runbook

### Layout and validation

- [CDK app](./bin/app.ts) and [stack](./lib/stack.ts): target fixed to the
  approved sandbox account and `eu-south-1`.
- [Handler](./runtime/handler.ts), [child supervisor](./runtime/server.ts),
  [protocol filter](./runtime/protocol.ts): buffered MCP adapter with a
  25-second total deadline and child termination before returning a failure.
  Credential headers are never forwarded to the child. Late or unknown write
  outcomes require reloading the estimate, not blind automatic retries.
- [Packaging](./scripts/package.cjs): rebuilds only generated `.staging/` and
  `artifact/` under `deploy/`, bundles explicit deployment dependencies and
  copies the catalog. Fails if it resolves root `node_modules`.
  Root artifacts and manifests are not rebuilt or modified.
- [Tests](./test/): REST event fixture, protocol/header handling, deadline,
  direct-call exclusion, packaged-server smoke and CDK template assertions.
  Package smoke uses memory storage and creates no external saved estimate.

Run from repository root (PowerShell):

```powershell
Set-Location deploy
npm ci --ignore-scripts
npm run typecheck
npm test
npm run synth
```

Generated template: `cdk.out/LthAwsPricingMcpStack.template.json`.
No bootstrap or AWS resource changes occur during these commands.
No test relies on Free Tier eligibility.

### Outputs: endpoint and credential reference

CDK outputs `ApiUrl` (full HTTPS URL including `/sandbox/mcp`), `ApiKeyId`,
`ApiKeyGeneration`, `UsagePlanId`, `EstimatesTableName` and `FunctionName`.
**The API key value is deliberately not a CloudFormation/CDK output.**
Outputs remain readable in stack metadata and logs; putting a credential there
would violate the agreed no-secrets-output requirement.

After an approved deployment, an authorized Windows operator can run:

```powershell
.\scripts\copy-api-key.ps1
```

The script verifies the account, reads stack outputs and retrieves the key
with the sandbox profile. It prints the API URL and key ID, but copies the
actual key only to the clipboard. Paste it into Copilot Studio's protected
connection credential field (`API key`, `Header`, `x-api-key`, no Bearer prefix).
Do not paste it into chat, files or terminal output. Disable clipboard history
and synchronization before use, then immediately clear the clipboard:

```powershell
.\scripts\copy-api-key.ps1 -ClearClipboard
```

Key retrieval requires operator `apigateway:GET` permission for the specific
key; the application Lambda has no such permission. Console retrieval is
also possible. Neither method has been executed as part of code generation.

### Pre-deployment review and shared settings

1. Revalidate STS, costs, regional reserved-concurrency quota, adapter startup,
   artifact size and the diff. Read-only commands:

   ```powershell
   aws sts get-caller-identity --profile lutechlab-sandbox --region eu-south-1
   aws apigateway get-account --profile lutechlab-sandbox --region eu-south-1
   npm run cdk -- diff --profile lutechlab-sandbox
   ```

2. API Gateway log delivery uses a **regional account-wide** CloudWatch role.
   Do not overwrite a role used by other APIs. If `get-account` reports an
   existing role, set `apiGatewayCloudWatchRoleArn` in CDK context to that ARN
   and verify its trust/log-delivery permissions for the new access-log group.
   In this mode the stack does not create `AWS::ApiGateway::Account` or replace
   that role. Without that context, it creates a narrowly scoped role and
   configures the account resource: approve this shared-setting change explicitly.
   No account-wide role setting is changed during synth.
3. Access logs and application logs retain 7 days. Execution logging and full
   request tracing are OFF; no unmanaged execution log group is needed.
   Only log-group/stream discovery permissions use wildcard resources because
   those discovery actions require them. Delivery is scoped to the access group.
4. Review bootstrap separately: it creates shared S3/IAM infrastructure.
   After explicit approval only:

   ```powershell
   npm run cdk -- bootstrap aws://695076071513/eu-south-1 --profile lutechlab-sandbox
   npm run cdk -- deploy LthAwsPricingMcpStack --profile lutechlab-sandbox
   ```

5. No `--require-approval never`, bootstrap, artifact publication, key creation,
   diff against AWS or deployment is performed automatically by the build/test.
   Observe CloudFormation to completion and execute T30 before client T31.

### API key rotation and emergency revocation

API key controls are sandbox usage controls, not user authentication.
Use a finite overlap; propagation can take minutes and must be measured.

1. Choose a new `apiKeyGeneration`, for example `v2`, and set
   `overlapApiKeyGenerations: ["v1"]` in `cdk.json`. Review the diff and obtain
   deployment approval. The existing logical key stays in place while a new
   generated key is bound to the same plan. `ApiKeyId` points to the new key.
2. Wait for association propagation, transfer the new key securely, update the
   connection and prove discovery/tool calls. Do not end overlap until verified.
3. Before the second approved deployment, empty `overlapApiKeyGenerations`
   and add `"v1"` to `revokedApiKeyGenerations`. This removes the old key and
   binding. Synth rejects any active/overlap generation listed as revoked.
4. Prove old-key rejection within the agreed measurable revocation interval.
   Quotas and throttle are best-effort; monitor Lambda/API metrics and spend.
5. For emergency disable, an authorized operator disables the key in API Gateway,
   updates committed generation/revocation context immediately, and reviews the
   next diff so IaC cannot restore it. Never roll back to a revoked generation.
   A new generation may be required before service can resume.

### Diagnostics, rollback and remaining acceptance

- 403: verify key enabled, plan/stage binding and propagation; confirm Lambda
  invocation metrics remain unchanged for rejected requests. Never log the key.
- 429: inspect stage/plan throttles and Lambda reserved concurrency. Limits
  are not spending guarantees.
- 502/504: inspect bounded adapter operational codes, startup/runtime metrics
  and service timeout. The child is terminated on forwarding failure.
  Reload state after uncertain writes; a write may already have committed.
- Conflict errors: reload the same estimate and reapply changes. The store
  never auto-merges stale snapshots. Drain all old unconditional writers.
- Rollback requires approval: restore a reviewed application artifact/template,
  retain DynamoDB/logs, and keep key revocation context current. Rolling back
  to the old unversioned writer is unsafe; do not mix old/new writers.
  No automated rollback or destroy is included.
- DynamoDB retains data on deletion/replacement, PITR is enabled and TTL is
  absent. Retained storage can continue billing after stack removal.
- Real DynamoDB persistence/concurrency, Linux/Lambda cold starts, wrong/missing/
  disabled-key rejection, rotation propagation and Copilot Studio T31 remain
  deployment acceptance tests, not local-test claims.
