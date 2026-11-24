'use strict';
// Runs the DynamoDB store against `dynalite` (a small DynamoDB emulator written in JavaScript),
// so create / get / list / updateIf are checked against real DynamoDB behaviour
// (conditional writes, filter expressions, reserved words like "status").
// Skipped automatically until `npm install` has installed dynalite and the AWS SDK.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let have = true;
try { require('dynalite'); require('@aws-sdk/lib-dynamodb'); } catch { have = false; }

let server;
let store;
before(async () => {
  if (!have) return;
  const dynalite = require('dynalite');
  const { DynamoDBClient, CreateTableCommand } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
  const { DynamoStore } = require('../lib/stores');
  server = dynalite({ createTableMs: 0 });
  await new Promise((resolve) => server.listen(0, resolve));
  const client = new DynamoDBClient({
    endpoint: `http://127.0.0.1:${server.address().port}`, region: 'us-east-1',
    credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
  });
  await client.send(new CreateTableCommand({
    TableName: 'TestTable', BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  }));
  store = new DynamoStore('TestTable', 'id', DynamoDBDocumentClient.from(client));
});
after(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

test('DynamoStore: create refuses a duplicate key and get returns the item', { skip: !have }, async () => {
  assert.equal(await store.create({ id: 'a', status: 'open', n: 1 }), true);
  assert.equal(await store.create({ id: 'a', status: 'x' }), false);
  assert.deepEqual(await store.get('a'), { id: 'a', status: 'open', n: 1 });
  assert.equal(await store.get('missing'), null);
});

test('DynamoStore: list filters by equality (including the reserved word "status")', { skip: !have }, async () => {
  await store.create({ id: 'b', status: 'open', campaignId: 'c1' });
  await store.create({ id: 'c', status: 'closed', campaignId: 'c1' });
  assert.equal((await store.list({ campaignId: 'c1' })).length, 2);
  assert.equal((await store.list({ campaignId: 'c1', status: 'closed' })).length, 1);
  assert.ok((await store.list()).length >= 3);
});

test('DynamoStore: updateIf changes the item only when the condition holds', { skip: !have }, async () => {
  assert.equal(await store.updateIf('a', { n: 5 }, { n: 99 }), null, 'condition fails');
  assert.equal((await store.get('a')).n, 1);
  const updated = await store.updateIf('a', { n: 5, status: 'closed' }, { status: 'open' });
  assert.deepEqual([updated.n, updated.status], [5, 'closed']);
  assert.equal(await store.updateIf('nope', { n: 1 }), null, 'missing item is not created');
  assert.equal(await store.get('nope'), null);
});
