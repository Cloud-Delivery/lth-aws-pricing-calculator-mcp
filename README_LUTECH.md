# Lutech AWS Pricing Calculator MCP

## Repository layout and upstream upgrades

- [`sample-aws-pricing-calculator-mcp`](./sample-aws-pricing-calculator-mcp/)
  is the unmodified AWS Samples Git submodule, tracking upstream `main`.
  The parent repository pins an exact commit; tracking `main` does not
  automatically upgrade it on checkout.
- [`deploy`](./deploy/) contains CDK, the Lambda adapter, dependencies,
  tests and [deployment-only overrides](./deploy/overrides/).
- [`aws-pricing-calculator`](./aws-pricing-calculator/) contains the
  Lutech Copilot Studio workspace.

Clone this repository with `git clone --recurse-submodules <fork-url>`.
For an existing checkout, run from the repository root:

```powershell
git submodule update --init --recursive
npm --prefix deploy ci
npm --prefix deploy test
```

Do not edit, build or install dependencies inside the upstream submodule.
CDK packaging copies its sources and catalog into `deploy/.staging`, applies
reviewed overrides there, then creates `deploy/artifact`.
See [the deployment workflow](./deploy/README.md#upstream-submodule-and-overrides).

To intentionally upgrade:

```powershell
git submodule update --remote sample-aws-pricing-calculator-mcp
npm --prefix deploy test
git diff --submodule=log
git add sample-aws-pricing-calculator-mcp
```

Review and commit the new gitlink with any required deployment adjustments.
If an overridden upstream file changes, packaging fails until the replacement
and its baseline hash have been reviewed; never update the hash blindly.
No infrastructure deployment is performed by these commands.

The Lutech `main` and `lutech` branches restart from a single independent
initial commit after the submodule migration. Existing clones must reconcile
the rewritten history; prefer a new recursive clone rather than merging
the old upstream-root history into the new branches.
The original upstream history remains in the submodule. GitHub's fork
relationship is separate from Git history and is not removed by this reset.

Migration limitation: the legacy root `.github/workflows/ci.yml` could not be
accessed because of the organization's content exclusion policy. It was left
untouched and requires an authorized follow-up review for the new layout.

### Workspace MCP tools for CDK deployments

The repository's [`.mcp.json`](./.mcp.json) adds these development tools alongside Copilot Studio:

| Server | Purpose |
|---|---|
| `aws-mcp` | Official managed AWS MCP: documentation and authenticated AWS API operations, including Lambda and API Gateway. |
| `awsiac` | CDK guidance, CloudFormation validation, compliance checks, and deployment troubleshooting. |
| `awspricing` | AWS pricing queries and CDK cost analysis before deployment. |

Install `uv` (providing `uvx`) and Python 3.10+ for the local IaC and Pricing servers. They use the standard AWS credential chain; select a named profile with `AWS_PROFILE` and a target region with `AWS_REGION` in the environment of the MCP client. Do not put credentials in the configuration.

The managed AWS server uses browser-based OAuth and requires the IAM permissions described in the [official setup guide](https://docs.aws.amazon.com/agent-toolkit/latest/userguide/getting-started-aws-mcp-server.html). Its `us-east-1` endpoint is the server location, not a required deployment region; explicitly specify the target region for API operations. OAuth authentication is separate from the local servers' AWS credentials.

Reload your MCP client and complete authentication to activate the servers. The AWS MCP server already includes knowledge tools, so a separate AWS Knowledge or legacy AWS API server is unnecessary. These tools do not replace the CDK CLI: install it in the deployment project and use `cdk synth`, `cdk diff`, and, after reviewing the changes, `cdk deploy`. Adding this configuration does not deploy resources or grant IAM permissions.

## Copilot Studio agent workspace

The [`aws-pricing-calculator`](./aws-pricing-calculator/) folder contains a
Copilot Studio agent scaffold with schema name `lcd_AWSPricingCalculator` and
Microsoft integrated authentication. Its instructions target the response
illustrated above: a real estimate link, an environment comparison table, and
concise design decisions. Numeric costs are retrieved only when explicitly
requested.

The workspace is currently local, not connected to a live agent or an MCP
connector, and not published. Without the MCP connection, the agent must label
architecture suggestions as drafts and must not invent estimate links or costs.
Web browsing is disabled; calculator operations should use the MCP tools.

To finish setup, authenticate the Power Platform CLI to the intended environment,
create or import the agent and synchronize the workspace. Then connect an
authenticated HTTPS deployment of this MCP through Copilot Studio's
[MCP onboarding wizard](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent).
Do not configure the AWS Calculator CDN URLs as the MCP server URL. Publishing
and enabling the Microsoft 365 Copilot channel are separate, explicitly approved
steps after testing.
