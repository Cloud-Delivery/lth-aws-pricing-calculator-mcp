# Project Guidelines

## Fork and Deployment Boundary

This repository is a Lutech fork of the upstream AWS Samples project.

- Put all Lutech-specific deployment code, infrastructure definitions, deployment configuration, and deployment documentation under `deploy/`.
- Treat the upstream/community files outside `deploy/` as read-only.
- Do not modify, refactor, reformat, or remove community files to implement Lutech-specific requirements.
- If a deployment change appears to require an upstream change, stop and ask for explicit approval before editing the community file.
- Keep deployment-specific configuration isolated from the upstream MCP server implementation and its tests.

## Documentation Boundary

- Do not modify the upstream `README.md`.
- Put Lutech-specific documentation and README updates in `README_LUTECH.md`.
