// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// For stateless multi-replica deployments where requests can land on any
// replica (e.g. a load-balanced HTTP front-end). The in-memory store
// (estimate-store.js#MemoryStore) would lose the estimate on any cross-
// replica request, so DynamoDB acts as the shared handoff. Stdio and
// single-replica HTTP deployments don't need this and use MemoryStore
// by default.
//
const EstimateBuilder = require('../aws/estimate-builder');
// AWS SDK is required up-front: by the time this file is loaded, the user
// has chosen ESTIMATES_STORE=dynamodb so the SDK must be installed. The
// lazy require lives in lib/store/estimate-store.js — guarding the *file*, not
// the symbols inside it.
const { GetCommand, PutCommand, DeleteCommand, DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');

class EstimateConflictError extends Error {
  constructor(cause) {
    super('Estimate changed or was deleted since it was read. Reload it and reapply your changes.', { cause });
    this.name = 'EstimateConflictError';
  }
}

// DynamoDB-backed store. Schema:
//   id        (S)  the estimate's UUID — partition key
//   snapshot  (S)  JSON.stringify(estimate.toJSON())
//   version   (N)  positive integer for optimistic concurrency; absent on legacy rows
//   expiresAt (N)  optional epoch seconds, intended for the table's TTL attr
//
// Snapshot is stored as a single JSON string rather than nested attributes
// because the estimate shape is variable and DDB's 400 KB per-item cap must
// not be exceeded — estimates with hundreds of services can approach that.
// Use S3-backed storage instead if you need bigger items.
class DynamoEstimateStore {
  constructor({ tableName, region, docClient, ttlSeconds } = {}) {
    if (!tableName) throw new Error('DynamoEstimateStore: tableName is required');
    this.tableName = tableName;
    this.ttlSeconds = ttlSeconds;
    this._docClient = docClient || DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    // Keep the version on each hydrated instance, not the ID or exported snapshot.
    this._versions = new WeakMap();
  }

  async get(id) {
    const result = await this._docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { id },
      ConsistentRead: true,
    }));
    if (!result.Item || !result.Item.snapshot) return null;
    const version = result.Item.version;
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
      throw new Error('DynamoEstimateStore: stored version must be a positive safe integer');
    }
    const obj = JSON.parse(result.Item.snapshot);
    const estimate = EstimateBuilder.fromJSON(obj);
    this._versions.set(estimate, { id, version });
    return estimate;
  }

  async put(estimate) {
    const previous = this._versions.get(estimate);
    if (previous && previous.id !== estimate.id) {
      throw new Error('DynamoEstimateStore: cannot change the ID of a stored estimate');
    }
    const version = (previous?.version ?? 0) + 1;
    if (!Number.isSafeInteger(version)) {
      throw new Error('DynamoEstimateStore: version exceeds the safe integer limit');
    }
    const item = {
      id: estimate.id,
      snapshot: JSON.stringify(estimate.toJSON()),
      version,
    };
    if (this.ttlSeconds && this.ttlSeconds > 0) {
      item.expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    }
    const condition = !previous
      ? { ConditionExpression: 'attribute_not_exists(#id)', ExpressionAttributeNames: { '#id': 'id' } }
      : previous.version === undefined
        ? {
          ConditionExpression: 'attribute_exists(#id) AND attribute_not_exists(#version)',
          ExpressionAttributeNames: { '#id': 'id', '#version': 'version' },
        }
        : {
          ConditionExpression: '#version = :expectedVersion',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':expectedVersion': previous.version },
        };
    try {
      await this._docClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ...condition,
      }));
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') throw new EstimateConflictError(err);
      throw err;
    }
    this._versions.set(estimate, { id: estimate.id, version });
  }

  async delete(id) {
    await this._docClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { id },
    }));
  }
}

module.exports = { DynamoEstimateStore, EstimateConflictError };
