'use strict';
// The data layer (Lab 7 "Model"). Two interchangeable stores with the SAME five methods,
// so controllers and business logic do not change:
//   MemoryStore   in the process memory: `npm run dev` and tests, nothing to install
//   DynamoStore   a DynamoDB table: used when the table's environment variable is set
//
//   create(item)                 add an item; false if the key already exists
//   get(key)                     one item or null
//   list(filters)                items whose fields equal every filter value
//   updateIf(key, patch, expect) change fields ONLY IF the item exists and its current
//                                fields equal `expect`; returns the new item or null.
//                                This is how we stop two requests from clobbering each other.

const clone = (x) => JSON.parse(JSON.stringify(x));

class MemoryStore {
  constructor(keyAttr = 'id') {
    this.keyAttr = keyAttr;
    this.kind = 'memory';
    this.items = new Map();
  }
  async create(item) {
    const key = item[this.keyAttr];
    if (this.items.has(key)) return false;
    this.items.set(key, clone(item));
    return true;
  }
  async get(key) {
    const item = this.items.get(key);
    return item ? clone(item) : null;
  }
  async list(filters = {}) {
    return [...this.items.values()]
      .filter((item) => Object.entries(filters).every(([k, v]) => item[k] === v))
      .map(clone);
  }
  async updateIf(key, patch, expect = {}) {
    const item = this.items.get(key);
    if (!item) return null;
    for (const [k, v] of Object.entries(expect)) if (item[k] !== v) return null;
    Object.assign(item, patch);
    return clone(item);
  }
}

class DynamoStore {
  // doc = a DynamoDBDocumentClient (injected so tests can point it at an emulator)
  constructor(tableName, keyAttr, doc) {
    this.table = tableName;
    this.keyAttr = keyAttr;
    this.doc = doc;
    this.kind = 'dynamodb';
    // Loaded here (not at the top) so memory-only runs never need the AWS SDK.
    this.cmd = require('@aws-sdk/lib-dynamodb');
  }
  async create(item) {
    const { PutCommand } = this.cmd;
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(#k)',
        ExpressionAttributeNames: { '#k': this.keyAttr },
      }));
      return true;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  async get(key) {
    const { GetCommand } = this.cmd;
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: { [this.keyAttr]: key } }));
    return result.Item || null;
  }
  async list(filters = {}) {
    const { ScanCommand } = this.cmd;
    const entries = Object.entries(filters);
    const params = { TableName: this.table };
    if (entries.length) {
      params.FilterExpression = entries.map((_, i) => `#f${i} = :f${i}`).join(' AND ');
      params.ExpressionAttributeNames = Object.fromEntries(entries.map(([k], i) => [`#f${i}`, k]));
      params.ExpressionAttributeValues = Object.fromEntries(entries.map(([, v], i) => [`:f${i}`, v]));
    }
    const items = [];
    let startKey;
    do {
      const page = await this.doc.send(new ScanCommand({ ...params, ExclusiveStartKey: startKey }));
      items.push(...(page.Items || []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items;
  }
  async updateIf(key, patch, expect = {}) {
    const { UpdateCommand } = this.cmd;
    const sets = Object.entries(patch).filter(([, v]) => v !== undefined);
    const guards = Object.entries(expect);
    const names = { '#key': this.keyAttr };
    const values = {};
    sets.forEach(([k, v], i) => { names[`#s${i}`] = k; values[`:s${i}`] = v; });
    guards.forEach(([k, v], i) => { names[`#g${i}`] = k; values[`:g${i}`] = v; });
    try {
      const result = await this.doc.send(new UpdateCommand({
        TableName: this.table,
        Key: { [this.keyAttr]: key },
        UpdateExpression: `SET ${sets.map((_, i) => `#s${i} = :s${i}`).join(', ')}`,
        ConditionExpression: ['attribute_exists(#key)', ...guards.map((_, i) => `#g${i} = :g${i}`)].join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }));
      return result.Attributes;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return null;
      throw error;
    }
  }
}

const memoryStores = new Map();

// Picks the store like Lab 7's issueService.js: DynamoDB when the table's environment
// variable is set (e.g. PLEDGES_TABLE=CharityPledges), otherwise memory.
// On Lambda the IAM role gives permission; on a laptop the "floci" AWS profile does. No keys in code.
function createStore(tableEnvVar, keyAttr = 'id') {
  const table = process.env[tableEnvVar];
  if (table) {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    return new DynamoStore(table, keyAttr, DynamoDBDocumentClient.from(new DynamoDBClient({})));
  }
  if (!memoryStores.has(tableEnvVar)) memoryStores.set(tableEnvVar, new MemoryStore(keyAttr));
  return memoryStores.get(tableEnvVar);
}

module.exports = { MemoryStore, DynamoStore, createStore };
