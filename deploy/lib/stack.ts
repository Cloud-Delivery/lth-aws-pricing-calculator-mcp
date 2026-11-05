import * as path from 'node:path';
import {
  CfnOutput, Duration, RemovalPolicy, Stack, StackProps,
  aws_apigateway as apigateway, aws_dynamodb as dynamodb,
  aws_iam as iam, aws_lambda as lambda, aws_logs as logs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class PricingMcpStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const table = new dynamodb.Table(this, 'Estimates', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const appLogs = new logs.LogGroup(this, 'ApplicationLogs', {
      retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN,
    });
    const apiLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN,
    });
    const handler = new lambda.Function(this, 'McpFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.X86_64,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.resolve(__dirname, '../../artifact')),
      memorySize: 1024, timeout: Duration.seconds(28),
      reservedConcurrentExecutions: 5,
      logGroup: appLogs,
      environment: {
        MCP_TRANSPORT: 'http', HOST: '127.0.0.1', PORT: '8000',
        ESTIMATES_STORE: 'dynamodb', ESTIMATES_TABLE: table.tableName,
        TRACE: 'off',
      },
    });
    handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [table.tableArn],
    }));
    const api = new apigateway.RestApi(this, 'McpApi', {
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
      cloudWatchRole: false,
      deployOptions: {
        stageName: 'sandbox',
        throttlingRateLimit: 5, throttlingBurstLimit: 10,
        dataTraceEnabled: false,
        loggingLevel: apigateway.MethodLoggingLevel.OFF,
        metricsEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiLogs),
        accessLogFormat: apigateway.AccessLogFormat.custom(JSON.stringify({
          requestId: '$context.requestId', httpMethod: '$context.httpMethod',
          resourcePath: '$context.resourcePath', status: '$context.status',
          responseLength: '$context.responseLength',
        })),
      },
    });
    const existingLogRole: unknown = this.node.tryGetContext('apiGatewayCloudWatchRoleArn');
    if (existingLogRole !== undefined) {
      if (typeof existingLogRole !== 'string'
        || !/^arn:aws:iam::695076071513:role\/[\w+=,.@/-]+$/.test(existingLogRole)) {
        throw new Error('apiGatewayCloudWatchRoleArn must be a role in the approved sandbox');
      }
      // Reuse the account's preconfigured role without changing shared settings.
      // Pre-deploy checks must verify its log-delivery permissions.
    } else {
      const logRole = new iam.Role(this, 'ApiLogRole', {
        assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      });
      logRole.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:GetLogEvents'],
        resources: [apiLogs.logGroupArn],
      }));
      logRole.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:DescribeLogGroups', 'logs:DescribeLogStreams'],
        resources: ['*'],
      }));
      const logAccount = new apigateway.CfnAccount(this, 'ApiLogAccount', {
        cloudWatchRoleArn: logRole.roleArn,
      });
      logAccount.node.addDependency(logRole);
      api.deploymentStage.node.addDependency(logAccount);
    }
    const integration = new apigateway.LambdaIntegration(handler, {
      proxy: true, timeout: Duration.seconds(29),
      allowTestInvoke: false,
      responseTransferMode: apigateway.ResponseTransferMode.BUFFERED,
    });
    const resource = api.root.addResource('mcp');
    for (const method of ['POST', 'GET', 'DELETE']) {
      resource.addMethod(method, integration, {
        apiKeyRequired: true, authorizationType: apigateway.AuthorizationType.NONE,
      });
    }
    const generation: unknown = this.node.tryGetContext('apiKeyGeneration');
    const revoked: unknown = this.node.tryGetContext('revokedApiKeyGenerations') ?? [];
    const overlap: unknown = this.node.tryGetContext('overlapApiKeyGenerations') ?? [];
    if (typeof generation !== 'string' || !/^[a-zA-Z0-9-]{1,32}$/.test(generation)) {
      throw new Error('apiKeyGeneration must be an alphanumeric/hyphen generation ID');
    }
    if (!Array.isArray(revoked) || !revoked.every(v => typeof v === 'string')) {
      throw new Error('revokedApiKeyGenerations must be a JSON array of generation IDs');
    }
    if (revoked.includes(generation)) throw new Error('Cannot redeploy a revoked API key generation');
    if (!Array.isArray(overlap) || !overlap.every(v => typeof v === 'string'
      && /^[a-zA-Z0-9-]{1,32}$/.test(v))) {
      throw new Error('overlapApiKeyGenerations must contain valid generation IDs');
    }
    const generations = [generation, ...overlap];
    if (new Set(generations).size !== generations.length) throw new Error('Duplicate API key generations');
    if (generations.some(v => revoked.includes(v))) throw new Error('Cannot redeploy a revoked API key generation');
    const plan = api.addUsagePlan('SandboxUsagePlan', {
      description: 'Sandbox-only key usage controls; not authentication',
      throttle: { rateLimit: 5, burstLimit: 10 },
      quota: { limit: 30000, period: apigateway.Period.MONTH },
      apiStages: [{ api, stage: api.deploymentStage }],
    });
    const keys = generations.map(value => {
      const key = new apigateway.ApiKey(this, `ConnectionKey-${value}`, {
        description: `Sandbox shared connection ${value}; usage control only`,
        enabled: true,
      });
      plan.addApiKey(key);
      return key;
    });
    const key = keys[0];
    new CfnOutput(this, 'ApiUrl', { value: api.urlForPath('/mcp') });
    new CfnOutput(this, 'ApiKeyId', { value: key.keyId });
    new CfnOutput(this, 'ApiKeyGeneration', { value: generation });
    new CfnOutput(this, 'UsagePlanId', { value: plan.usagePlanId });
    new CfnOutput(this, 'EstimatesTableName', { value: table.tableName });
    new CfnOutput(this, 'FunctionName', { value: handler.functionName });
  }
}
