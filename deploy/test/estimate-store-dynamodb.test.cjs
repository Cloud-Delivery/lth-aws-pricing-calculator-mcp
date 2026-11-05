const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DynamoEstimateStore, EstimateConflictError } = require('../.staging/lib/store/estimate-store-dynamodb');
const EstimateBuilder = require('../.staging/lib/aws/estimate-builder');

class FakeDocClient {
  constructor() {
    this.rows = new Map();
    this.calls = [];
  }
  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    this.calls.push({ name, input });
    if (name === 'GetCommand') {
      const item = this.rows.get(input.Key.id);
      return { Item: item ?? undefined };
    }
    if (name === 'PutCommand') {
      const current = this.rows.get(input.Item.id);
      let allowed;
      switch (input.ConditionExpression) {
        case 'attribute_not_exists(#id)':
          assert.deepEqual(input.ExpressionAttributeNames, { '#id': 'id' });
          allowed = !current;
          break;
        case 'attribute_exists(#id) AND attribute_not_exists(#version)':
          assert.deepEqual(input.ExpressionAttributeNames, { '#id': 'id', '#version': 'version' });
          allowed = !!current && current.version === undefined;
          break;
        case '#version = :expectedVersion':
          assert.deepEqual(input.ExpressionAttributeNames, { '#version': 'version' });
          allowed = !!current && current.version === input.ExpressionAttributeValues[':expectedVersion'];
          break;
        default:
          throw new Error(`Missing or unexpected write condition: ${input.ConditionExpression}`);
      }
      if (!allowed) {
        const error = new Error('Fixture conditional check failed');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      this.rows.set(input.Item.id, input.Item);
      return {};
    }
    if (name === 'DeleteCommand') {
      this.rows.delete(input.Key.id);
      return {};
    }
    throw new Error(`Unsupported command in FakeDocClient: ${name}`);
  }
}

describe('DynamoEstimateStore', () => {
  let fakeClient;
  let store;

  beforeEach(() => {
    fakeClient = new FakeDocClient();
    store = new DynamoEstimateStore({
      tableName: 'estimates-test',
      docClient: fakeClient,
    });
  });

  it('returns null for unknown id', async () => {
    assert.equal(await store.get('missing'), null);
    assert.equal(fakeClient.calls.length, 1);
    assert.equal(fakeClient.calls[0].name, 'GetCommand');
    assert.equal(fakeClient.calls[0].input.TableName, 'estimates-test');
    assert.deepEqual(fakeClient.calls[0].input.Key, { id: 'missing' });
    assert.equal(fakeClient.calls[0].input.ConsistentRead, true);
  });

  it('puts an estimate as a JSON snapshot', async () => {
    const e = new EstimateBuilder('test', 'aws');
    e.addService('aWSLambda', { region: 'us-east-1' });
    await store.put(e);

    assert.equal(fakeClient.calls.length, 1);
    assert.equal(fakeClient.calls[0].name, 'PutCommand');
    const item = fakeClient.calls[0].input.Item;
    assert.equal(item.id, e.id);
    assert.equal(typeof item.snapshot, 'string',
      'snapshot must be a JSON string for portability');
    const parsed = JSON.parse(item.snapshot);
    assert.equal(parsed.id, e.id);
    assert.equal(parsed.name, 'test');
    assert.equal(item.version, 1);
    assert.equal(parsed.version, undefined);
    assert.equal(fakeClient.calls[0].input.ConditionExpression, 'attribute_not_exists(#id)');
  });

  it('round-trips through put + get yielding a hydrated EstimateBuilder', async () => {
    const e = new EstimateBuilder('test', 'aws');
    e.addService('aWSLambda', { region: 'us-east-1' });
    await store.put(e);

    const got = await store.get(e.id);
    assert.ok(got);
    assert.equal(got.id, e.id);
    assert.equal(typeof got.addService, 'function');
    assert.deepEqual(got.services, e.services);
  });

  it('increments the version for successive writes of the same instance', async () => {
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);
    e.name = 'updated';
    await store.put(e);
    assert.equal(fakeClient.rows.get(e.id).version, 2);
    assert.deepEqual(fakeClient.calls[1].input.ExpressionAttributeValues, { ':expectedVersion': 1 });
    const got = await store.get(e.id);
    got.name = 'updated again';
    await store.put(got);
    assert.equal(fakeClient.rows.get(e.id).version, 3);
    assert.equal((await store.get(e.id)).name, 'updated again');
    assert.equal(got.toJSON().version, undefined);
  });

  it('rejects stale writers across store instances without replacing the winner', async () => {
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);
    const otherStore = new DynamoEstimateStore({ tableName: 'estimates-test', docClient: fakeClient });
    const [first, second] = await Promise.all([store.get(e.id), otherStore.get(e.id)]);
    first.name = 'first';
    second.name = 'second';
    const results = await Promise.allSettled([store.put(first), otherStore.put(second)]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.ok(results[1].reason instanceof EstimateConflictError);
    assert.equal(results[1].reason.cause.name, 'ConditionalCheckFailedException');
    assert.match(results[1].reason.message, /Reload it and reapply/);
    assert.equal((await store.get(e.id)).name, 'first');
    assert.equal(fakeClient.rows.get(e.id).version, 2);
    // Conflicts do not auto-retry or advance the stale instance's version.
    assert.equal(fakeClient.calls.filter(call => call.name === 'PutCommand').length, 3);
    await assert.rejects(otherStore.put(second), EstimateConflictError);
    const reloaded = await otherStore.get(e.id);
    reloaded.name = 'second reapplied';
    await otherStore.put(reloaded);
    assert.equal((await store.get(e.id)).name, 'second reapplied');
    assert.equal(fakeClient.rows.get(e.id).version, 3);
  });

  it('does not let a detached snapshot overwrite an existing estimate', async () => {
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);
    const detached = EstimateBuilder.fromJSON(e.toJSON());
    detached.name = 'collision';
    await assert.rejects(store.put(detached), EstimateConflictError);
    assert.equal((await store.get(e.id)).name, 'test');
  });

  it('allows only one concurrent creation of the same ID', async () => {
    const first = new EstimateBuilder('first', 'aws');
    const second = EstimateBuilder.fromJSON(first.toJSON());
    second.name = 'second';
    const results = await Promise.allSettled([store.put(first), store.put(second)]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.ok(results[1].reason instanceof EstimateConflictError);
    assert.equal(fakeClient.rows.get(first.id).version, 1);
    assert.equal((await store.get(first.id)).name, 'first');
  });

  it('upgrades a legacy row to version 1 and rejects another legacy reader', async () => {
    const e = new EstimateBuilder('legacy', 'aws');
    fakeClient.rows.set(e.id, { id: e.id, snapshot: JSON.stringify(e.toJSON()) });
    const [first, second] = await Promise.all([store.get(e.id), store.get(e.id)]);
    first.name = 'upgraded';
    await store.put(first);
    assert.equal(fakeClient.rows.get(e.id).version, 1);
    second.name = 'stale legacy';
    await assert.rejects(store.put(second), EstimateConflictError);
    assert.equal((await store.get(e.id)).name, 'upgraded');
    await store.put(first);
    assert.equal(fakeClient.rows.get(e.id).version, 2);
  });

  it('does not resurrect a deleted versioned row', async () => {
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);
    const got = await store.get(e.id);
    await store.delete(e.id);
    await assert.rejects(store.put(got), EstimateConflictError);
    assert.equal(await store.get(e.id), null);
  });

  it('does not resurrect a deleted legacy row', async () => {
    const e = new EstimateBuilder('legacy', 'aws');
    fakeClient.rows.set(e.id, { id: e.id, snapshot: JSON.stringify(e.toJSON()) });
    const got = await store.get(e.id);
    await store.delete(e.id);
    await assert.rejects(store.put(got), EstimateConflictError);
    assert.equal(await store.get(e.id), null);
  });

  it('rejects invalid persisted versions explicitly', async () => {
    const e = new EstimateBuilder('test', 'aws');
    for (const version of [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      fakeClient.rows.set(e.id, { id: e.id, snapshot: JSON.stringify(e.toJSON()), version });
      await assert.rejects(store.get(e.id), /stored version must be a positive safe integer/);
    }
  });

  it('rejects version overflow before writing', async () => {
    const e = new EstimateBuilder('test', 'aws');
    fakeClient.rows.set(e.id, {
      id: e.id, snapshot: JSON.stringify(e.toJSON()), version: Number.MAX_SAFE_INTEGER,
    });
    const got = await store.get(e.id);
    await assert.rejects(store.put(got), /version exceeds the safe integer limit/);
    assert.equal(fakeClient.calls.filter(call => call.name === 'PutCommand').length, 0);
  });

  it('rejects changing the ID of a hydrated estimate', async () => {
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);
    const got = await store.get(e.id);
    got.id = 'different-id';
    await assert.rejects(store.put(got), /cannot change the ID/);
    assert.equal(await store.get('different-id'), null);
  });

  it('propagates operational errors and only advances versions after success', async () => {
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);
    const send = fakeClient.send.bind(fakeClient);
    const error = new Error('Fixture service unavailable');
    fakeClient.send = async () => { throw error; };
    await assert.rejects(store.get(e.id), err => err === error);
    await assert.rejects(store.put(e), err => err === error);
    fakeClient.send = send;
    await store.put(e);
    assert.equal(fakeClient.rows.get(e.id).version, 2);
    assert.equal(fakeClient.calls.at(-1).input.ExpressionAttributeValues[':expectedVersion'], 1);
  });

  it('can retry creation after an operational failure without creating a false version', async () => {
    const e = new EstimateBuilder('test', 'aws');
    const send = fakeClient.send.bind(fakeClient);
    const error = new Error('Fixture service unavailable');
    fakeClient.send = async () => { throw error; };
    await assert.rejects(store.put(e), err => err === error);
    fakeClient.send = send;
    await store.put(e);
    assert.equal(fakeClient.rows.get(e.id).version, 1);
    assert.equal(fakeClient.calls[0].input.ConditionExpression, 'attribute_not_exists(#id)');
  });

  it('writes a TTL attribute when ttlSeconds is configured', async () => {
    const ttlStore = new DynamoEstimateStore({
      tableName: 'estimates-test',
      docClient: fakeClient,
      ttlSeconds: 3600,
    });
    const e = new EstimateBuilder('test', 'aws');
    const before = Math.floor(Date.now() / 1000);
    await ttlStore.put(e);
    const item = fakeClient.calls[0].input.Item;
    assert.ok(typeof item.expiresAt === 'number',
      'expiresAt must be a numeric epoch second when TTL is configured');
    assert.ok(item.expiresAt >= before + 3600 - 1);
    assert.ok(item.expiresAt <= before + 3600 + 5);
  });

  it('omits TTL when ttlSeconds is not configured', async () => {
    const e = new EstimateBuilder('test', 'aws');
    await store.put(e);
    const item = fakeClient.calls[0].input.Item;
    assert.equal(item.expiresAt, undefined);
  });

  it('preserves TTL configuration when upgrading and updating a legacy row', async () => {
    const ttlStore = new DynamoEstimateStore({
      tableName: 'estimates-test', docClient: fakeClient, ttlSeconds: 3600,
    });
    const e = new EstimateBuilder('legacy', 'aws');
    fakeClient.rows.set(e.id, { id: e.id, snapshot: JSON.stringify(e.toJSON()) });
    const got = await ttlStore.get(e.id);
    await ttlStore.put(got);
    await ttlStore.put(got);
    const item = fakeClient.rows.get(e.id);
    assert.equal(item.version, 2);
    assert.ok(item.expiresAt >= Math.floor(Date.now() / 1000) + 3599);
    assert.equal(JSON.parse(item.snapshot).expiresAt, undefined);
  });

  it('delete sends DeleteCommand against the configured table', async () => {
    await store.delete('some-id');
    assert.equal(fakeClient.calls[0].name, 'DeleteCommand');
    assert.equal(fakeClient.calls[0].input.TableName, 'estimates-test');
    assert.deepEqual(fakeClient.calls[0].input.Key, { id: 'some-id' });
  });

  it('factory rejects construction without tableName', () => {
    assert.throws(
      () => new DynamoEstimateStore({ docClient: fakeClient }),
      /tableName is required/,
    );
  });
});

describe('createEstimateStore + dynamodb wiring', () => {
  it('createEstimateStore("dynamodb") returns a DynamoEstimateStore', () => {
    const { createEstimateStore } = require('../.staging/lib/store/estimate-store');
    const store = createEstimateStore({
      ESTIMATES_STORE: 'dynamodb',
      ESTIMATES_TABLE: 'estimates-test',
      AWS_REGION: 'us-east-1',
    });
    assert.equal(store.constructor.name, 'DynamoEstimateStore');
  });
});
