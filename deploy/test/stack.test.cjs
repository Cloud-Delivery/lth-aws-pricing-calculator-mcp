const { test } = require('node:test');
const assert = require('node:assert/strict');
const { App } = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { PricingMcpStack } = require('../build/lib/stack');

function template(context = {}) {
  const app = new App({ context: { apiKeyGeneration: 'v1', revokedApiKeyGenerations: [], ...context } });
  return Template.fromStack(new PricingMcpStack(app, 'Test', {
    env: { account: '695076071513', region: 'eu-south-1' },
  })).toJSON();
}

test('every MCP method requires a key; no bypass or authorizer exists', () => {
  const cf = template();
  const methods = Object.values(cf.Resources).filter(r => r.Type === 'AWS::ApiGateway::Method');
  assert.equal(methods.length, 3);
  assert.deepEqual(methods.map(r => r.Properties.HttpMethod).sort(), ['DELETE', 'GET', 'POST']);
  for (const method of methods) {
    assert.equal(method.Properties.ApiKeyRequired, true);
    assert.equal(method.Properties.AuthorizationType, 'NONE');
    assert.equal(method.Properties.Integration.Type, 'AWS_PROXY');
    assert.equal(method.Properties.Integration.TimeoutInMillis, 29000);
  }
  for (const type of ['AWS::Lambda::Url', 'AWS::ApiGateway::Authorizer', 'AWS::SecretsManager::Secret',
    'AWS::EC2::VPC', 'AWS::EC2::NatGateway']) {
    assert.equal(Object.values(cf.Resources).some(r => r.Type === type), false);
  }
  const api = Object.values(cf.Resources).find(r => r.Type === 'AWS::ApiGateway::RestApi');
  assert.equal(api.Properties.ApiKeySourceType, 'HEADER');
  assert.deepEqual(api.Properties.EndpointConfiguration.Types, ['REGIONAL']);
  const resources = Object.values(cf.Resources).filter(r => r.Type === 'AWS::ApiGateway::Resource');
  assert.equal(resources.length, 1);
  assert.equal(resources[0].Properties.PathPart, 'mcp');
});

test('key is generated, bound to a dedicated plan/stage and never output as a value', () => {
  const cf = template();
  const key = Object.values(cf.Resources).find(r => r.Type === 'AWS::ApiGateway::ApiKey');
  assert.equal(key.Properties.Enabled, true);
  assert.equal(key.Properties.Value, undefined);
  const plan = Object.values(cf.Resources).find(r => r.Type === 'AWS::ApiGateway::UsagePlan');
  assert.equal(plan.Properties.ApiStages.length, 1);
  assert.equal(plan.Properties.Quota.Limit, 30000);
  assert.equal(plan.Properties.Throttle.RateLimit, 5);
  const binding = Object.values(cf.Resources).find(r => r.Type === 'AWS::ApiGateway::UsagePlanKey');
  assert.equal(binding.Properties.KeyType, 'API_KEY');
  assert.ok(cf.Outputs.ApiUrl);
  assert.ok(cf.Outputs.ApiKeyId);
  assert.equal(cf.Outputs.ApiKey, undefined);
  assert.ok(!JSON.stringify(cf.Outputs).includes('ValueFor'));
});

test('all logs retain seven days; no full request/credential logging enabled', () => {
  const cf = template();
  const groups = Object.values(cf.Resources).filter(r => r.Type === 'AWS::Logs::LogGroup');
  assert.equal(groups.length, 2);
  for (const group of groups) assert.equal(group.Properties.RetentionInDays, 7);
  const stage = Object.values(cf.Resources).find(r => r.Type === 'AWS::ApiGateway::Stage');
  assert.equal(stage.Properties.StageName, 'sandbox');
  const logFormat = stage.Properties.AccessLogSetting.Format;
  assert.ok(logFormat.includes('$context.requestId'));
  assert.ok(!/apiKey|Authorization|body|payload/.test(logFormat));
  for (const settings of stage.Properties.MethodSettings) {
    assert.equal(settings.DataTraceEnabled, false);
    assert.equal(settings.LoggingLevel, 'OFF');
  }
});

test('DynamoDB and runtime wiring preserve data and constrain IAM', () => {
  const cf = template();
  const entries = Object.entries(cf.Resources);
  const [tableId, table] = entries.find(([, r]) => r.Type === 'AWS::DynamoDB::Table');
  assert.equal(table.DeletionPolicy, 'Retain');
  assert.equal(table.UpdateReplacePolicy, 'Retain');
  assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST');
  assert.deepEqual(table.Properties.KeySchema, [{ AttributeName: 'id', KeyType: 'HASH' }]);
  assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  assert.equal(table.Properties.TimeToLiveSpecification, undefined);
  const fn = Object.values(cf.Resources).find(r => r.Type === 'AWS::Lambda::Function');
  assert.equal(fn.Properties.Runtime, 'nodejs24.x');
  assert.equal(fn.Properties.MemorySize, 1024);
  assert.equal(fn.Properties.Timeout, 28);
  assert.equal(fn.Properties.ReservedConcurrentExecutions, 5);
  assert.deepEqual(fn.Properties.Environment.Variables.ESTIMATES_TABLE, { Ref: tableId });
  assert.equal(fn.Properties.Environment.Variables.ESTIMATES_STORE, 'dynamodb');
  assert.equal(fn.Properties.Environment.Variables.TRACE, 'off');
  const policies = Object.values(cf.Resources).filter(r => r.Type === 'AWS::IAM::Policy');
  const statements = policies.flatMap(r => r.Properties.PolicyDocument.Statement);
  const ddb = statements.filter(s => JSON.stringify(s.Action).includes('dynamodb:'));
  assert.equal(ddb.length, 1);
  assert.deepEqual(ddb[0].Action.sort(), ['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem']);
  assert.deepEqual(ddb[0].Resource, { 'Fn::GetAtt': [tableId, 'Arn'] });
  assert.ok(!JSON.stringify(policies).includes('apigateway:GET'));
  assert.ok(!JSON.stringify(policies).includes('secretsmanager:'));
});

test('revoked generations cannot be restored by synth', () => {
  assert.throws(() => template({ revokedApiKeyGenerations: ['v1'] }), /revoked API key generation/);
  assert.throws(() => template({ apiKeyGeneration: 'bad generation!' }), /generation ID/);
  const first = template();
  const second = template({ apiKeyGeneration: 'v2', revokedApiKeyGenerations: ['v1'] });
  const keyId = cf => Object.entries(cf.Resources).find(([, r]) => r.Type === 'AWS::ApiGateway::ApiKey')[0];
  assert.notEqual(keyId(first), keyId(second));
  const overlapping = template({ apiKeyGeneration: 'v2', overlapApiKeyGenerations: ['v1'] });
  assert.equal(Object.values(overlapping.Resources).filter(r => r.Type === 'AWS::ApiGateway::ApiKey').length, 2);
  assert.throws(() => template({ apiKeyGeneration: 'v2', overlapApiKeyGenerations: ['v1'],
    revokedApiKeyGenerations: ['v1'] }), /revoked API key generation/);
  assert.throws(() => template({ overlapApiKeyGenerations: ['v1'] }), /Duplicate API key generations/);
});

test('existing regional API Gateway logging configuration is not replaced', () => {
  const cf = template({ apiGatewayCloudWatchRoleArn: 'arn:aws:iam::695076071513:role/ExistingApiLogRole' });
  assert.equal(Object.values(cf.Resources).some(r => r.Type === 'AWS::ApiGateway::Account'), false);
  assert.throws(() => template({
    apiGatewayCloudWatchRoleArn: 'arn:aws:iam::123456789012:role/OtherAccount',
  }), /approved sandbox/);
});
