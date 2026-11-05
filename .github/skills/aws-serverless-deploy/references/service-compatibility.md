# Service compatibility checklist

Re-read the current implementation before relying on these observations.
These are constraints to validate, not a ready-made Lambda architecture.

## HTTP and protocol

- `mcp-server.js` starts an Express listener when `MCP_TRANSPORT=http`.
  It does not export a production Lambda handler or Express application.
  Choose and test an adapter/wrapper under `deploy/`; do not assume a generic
  Express-to-Lambda wrapper can import the application directly.
- The default listener is `127.0.0.1:8000`. Configure host/port according to
  the selected adapter and provide a working readiness check. `/health` is not
  an existing application route.
- `/mcp` supports POST. GET and DELETE return 405.
- The transport is Streamable HTTP with `sessionIdGenerator: undefined`.
  Prove initialization, notifications, content negotiation, SSE framing where
  applicable and header forwarding through the actual API integration.
- Each request closes the previous singleton server transport before attaching
  a new one. Do not assume concurrent requests within one process are safe.
- Trace context reads the incoming `Mcp-Session-Id` header. The upstream server
  does not generate it. Establish whether the client or deployment supplies it;
  never treat a caller-controlled session header as authorization.

## State and package contents

- `ESTIMATES_STORE=memory` loses state across cold starts and independent Lambda
  environments. Use `ESTIMATES_STORE=dynamodb` and `ESTIMATES_TABLE`.
- Package `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` explicitly;
  they are optional peer dependencies and external to the upstream bundle.
- Verify the store's key/schema, TTL attribute and update semantics before
  defining a table. Test concurrent updates; DynamoDB alone is not proof of
  isolation or protection against lost writes.
- Verify how caller identity scopes estimates. Authentication at the API does
  not by itself establish per-user isolation in the application's store.
- Package the service catalog and preserve expected relative paths, or set
  `CALCMCP_CATALOG_DIR` to the actual packaged directory.
- The root build produces a bundle contract and a ZIP, but that is not proof
  that its ZIP is a complete, Lambda-ready deployment artifact. Validate the
  chosen package contents and startup in isolation.

## Browser and duration

- `get_estimate_cost` needs Playwright, Chromium and system libraries. A
  successful ordinary MCP request does not validate this capability.
- Verify Linux architecture compatibility, writable directories, browser
  sandbox requirements, artifact size, memory, cold starts and execution time.
  A container image may be appropriate; do not choose it without assessment.
- This tool re-shares an estimate and creates an external saved copy. Run it
  only on explicit request, never as an automatic cost-estimation step.
- API integration, client and Lambda timeout limits all apply. Streaming or
  extending the Lambda timeout alone does not remove a shorter upstream limit.
- If full tool parity cannot be supported, explain the limitation and get a
  decision rather than silently dropping the browser-dependent tool.
