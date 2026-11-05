---
name: aws-serverless-deploy
description: "Use when preparing or executing deployment of this AWS Pricing Calculator MCP service to AWS Lambda and API Gateway using CDK, including sandbox setup, packaging, DynamoDB persistence, validation, smoke tests and rollback."
---

# Deploy this MCP service with CDK

Prepare or deploy only the phase the user requested. Creating this customization
does not authorize generating infrastructure or deploying it.

## 1. Inspect and establish the target

- Read `.github/copilot-instructions.md`, `.mcp.json`, the package manifest,
  HTTP entrypoint and persistence implementation. Inspect existing `deploy/`
  assets before creating alternatives. Preserve unrelated worktree changes.
- Keep all deployment implementation, manifests, lockfiles, tests, staging
  outputs and documentation in `deploy/`. Do not run root build commands that
  overwrite upstream artifacts. If packaging requires a build, build from an
  isolated staging copy under `deploy/`, preserving source-relative paths.
- Use profile `lutechlab-sandbox` for every authenticated local AWS/CDK command.
  Discover `aws-mcp` tools and verify STS caller identity before AWS work.
  Confirm the actual account is the intended sandbox; profile names alone are
  not proof. Confirm region with the user if no deployment target is recorded.
- The MCP endpoint's region is not the deployment region. Pass the deployment
  region explicitly to AWS operations and CDK.
- IaC and Pricing MCP servers currently use inherited local credentials, not
  the explicit profile configured on `aws-mcp`. Before authenticated calls,
  verify their credential context or ask to configure them for the same profile.
  Do not silently use another account. Public documentation needs no credentials.

## 2. Prove Lambda compatibility before writing a stack

Read [the service compatibility checklist](./references/service-compatibility.md).
Use `awsknowledge` and `awsiac` to verify current Lambda, API Gateway, adapter,
CDK and runtime capabilities. Do not copy obsolete limits from memory.

Resolve these decisions explicitly:

- The Lambda entrypoint or HTTP adapter and its packaging requirements.
- API Gateway HTTP versus REST API, buffering versus response streaming,
  supported MCP content types and the effective integration timeout.
- Endpoint authentication compatible with the intended MCP client. Ask when
  the client or auth requirement is unknown; no unauthenticated public default.
- DynamoDB persistence, session isolation and concurrent estimate updates.
- Whether computed-cost tools requiring Chromium are in scope. Never silently
  remove tools or report an unavailable tool as working.

If a required capability does not fit Lambda/API Gateway, explain the measured
constraint and ask before changing architecture or upstream code.

## 3. Estimate and get design agreement

- Use `awspricing` with explicit region and documented traffic assumptions.
  Include Lambda duration/memory/requests, API Gateway, DynamoDB, logs, storage
  and any image registry, data transfer or network costs actually introduced.
- Present assumptions and approximate monthly costs before generating IaC.
  Do not promise zero cost or silently assume Free Tier eligibility.
- Keep dev-sized defaults. Avoid a VPC/NAT gateway unless connectivity requires
  it. Confirm significant scope choices, auth and unresolved compatibility.

## 4. Implement under deploy/

- Prefer one CDK TypeScript application unless an existing deployment uses a
  different language. Use a separate manifest and lockfile, compatible pinned
  dependencies and supported runtimes. Reuse existing deployment assets.
- Package the upstream service and catalog without modifying them. Include
  external runtime dependencies explicitly; do not assume dev dependencies or
  optional peer dependencies exist in Lambda.
- Set HTTP transport environment variables as required by the chosen adapter,
  including host and port. Use DynamoDB for cross-invocation estimate state,
  configuring the table name and store mode.
- Apply least-privilege table access, encryption, explicit log retention,
  request throttling, bounded concurrency and intentional timeout/memory values.
  Avoid logging credentials, tokens or full user estimate payloads.
- Document API authentication, environment variables, packaging, bootstrap,
  synth/diff/deploy commands, smoke tests and rollback under `deploy/`.
  Retain persistent data by default; require separate approval for destruction.

## 5. Validate without deploying

- Run the deployment project's type-check, tests and CDK synthesis. Test adapter
  behavior with actual API Gateway event fixtures and MCP requests.
- Assert template properties for authentication, least-privilege IAM, table
  wiring, logs, retention and runtime configuration.
- Use `awsiac` template validation, compliance checks and pre-deploy validation
  guidance. Report every failing check; fix or obtain a documented exception.
- Review `cdk diff` against the exact account/region. Diff/lookups may contact
  AWS; distinguish these read operations from infrastructure changes.
- If validation cannot run, report it as blocked, not passed.

## 6. Deploy only with approval

Show account, region, stack name, costs, validation results and diff. Ask for
explicit approval before `cdk bootstrap`, `cdk deploy`, CloudFormation execution,
image publication or any other resource-changing operation. Explain bootstrap
separately because it creates shared resources and IAM roles.

Use the deployment project's CDK command with `--profile lutechlab-sandbox`
and an explicit target environment. Do not disable approval prompts to bypass
review. Monitor CloudFormation to a terminal state; inspect events on failure.
Do not blindly retry, delete a stack, or change account to bypass a failure.

## 7. Verify the deployed MCP protocol

- Use the real endpoint and intended client authentication to perform MCP
  initialization, the initialized notification and `tools/list`.
- Exercise a non-mutating tool and verify JSON-RPC responses and content types.
  Confirm GET/DELETE behavior and unauthenticated requests match the design.
- Test `create_estimate` then a follow-up read/update across separate Lambda
  invocations, including a cold start, proving persistence and isolation.
  Do not use `build_estimate` or export tools as a harmless smoke test: they
  save estimates externally. Obtain approval before those checks.
- Check CloudWatch for invocation errors, throttling and timeouts. Test the
  supported long-running path against the actual API integration limit.
- Report stack outputs, test evidence, known limitations and rollback guidance.
  Do not destroy persistent state or perform a rollback without approval.
