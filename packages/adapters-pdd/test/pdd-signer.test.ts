/**
 * 拼多多签名实现的官方示例验证。
 *
 * 这个文件的核心价值只有一条：**用官方文档给出的示例参数，断言算出的 sign
 * 与文档写明的结果逐字节一致**。如果这条不过，说明实现与官方算法有偏差，
 * 后面任何真实调用都不可能成功。
 *
 * 官方示例来源：open.pinduoduo.com → 基础文档/开发文档/API调用详解
 *   https://open.pinduoduo.com/application/document/browse?idStr=8EC06C399636041E
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPddRequestBody, computePddSign, PDD_GATEWAY } from '../src/http/pdd-signer.js';

/** 官方文档「调用示例」一节的原样参数。 */
const OFFICIAL_SAMPLE = {
  access_token: 'asd78172s8ds9a921j9qqwda12312w1w21211',
  client_id: 1,
  data_type: 'XML',
  order_status: 1,
  page: 1,
  page_size: 10,
  timestamp: 1480411125,
  type: 'pdd.order.number.list.get',
};

const OFFICIAL_SECRET = 'testSecret';

/** 官方文档写明的期望结果。 */
const OFFICIAL_EXPECTED_SIGN = 'E4DE3ED21002510DED352819E7AE6775';

test('官方示例：sign 与文档逐字节一致', () => {
  const sign = computePddSign(OFFICIAL_SAMPLE, OFFICIAL_SECRET);
  assert.equal(sign, OFFICIAL_EXPECTED_SIGN);
});

test('官方示例：签名材料顺序为 ASCII 升序（access_token < client_id < data_type < ...）', () => {
  // 官方文档展示了排序后的顺序，这里间接验证：把参数以乱序传入，结果不变。
  const shuffled = {
    type: 'pdd.order.number.list.get',
    timestamp: 1480411125,
    page_size: 10,
    page: 1,
    order_status: 1,
    data_type: 'XML',
    client_id: 1,
    access_token: 'asd78172s8ds9a921j9qqwda12312w1w21211',
  };
  assert.equal(computePddSign(shuffled, OFFICIAL_SECRET), OFFICIAL_EXPECTED_SIGN);
});

test('sign 恒为 32 位大写十六进制', () => {
  const sign = computePddSign({ type: 'pdd.time.get', client_id: 'abc' }, 'secret');
  assert.match(sign, /^[0-9A-F]{32}$/);
});

test('空值不参与签名（null / undefined / 空串）', () => {
  const withEmpty = computePddSign(
    { type: 'pdd.time.get', client_id: 'abc', empty: '', missing: undefined, nul: null },
    'secret',
  );
  const withoutEmpty = computePddSign({ type: 'pdd.time.get', client_id: 'abc' }, 'secret');
  assert.equal(withEmpty, withoutEmpty);
});

test('数字与同值字符串产生相同签名（官方示例中 client_id=1 拼为 client_id1）', () => {
  const asNumber = computePddSign({ client_id: 1, timestamp: 1480411125 }, 'secret');
  const asString = computePddSign({ client_id: '1', timestamp: '1480411125' }, 'secret');
  assert.equal(asNumber, asString);
});

test('client_secret 参与首尾两次拼接：不同 secret 产生不同签名', () => {
  const a = computePddSign({ type: 'pdd.time.get' }, 'secretA');
  const b = computePddSign({ type: 'pdd.time.get' }, 'secretB');
  assert.notEqual(a, b);
});

test('buildPddRequestBody 注入全部公共参数并附带 sign', () => {
  const { body, sign, timestamp } = buildPddRequestBody(
    'pdd.order.number.list.get',
    { order_status: 1, page: 1, page_size: 10 },
    {
      clientId: '1',
      clientSecret: OFFICIAL_SECRET,
      accessToken: 'asd78172s8ds9a921j9qqwda12312w1w21211',
      timestamp: 1480411125,
    },
  );

  assert.equal(timestamp, 1480411125);
  assert.equal(body.type, 'pdd.order.number.list.get');
  assert.equal(body.client_id, '1');
  assert.equal(body.timestamp, 1480411125);
  assert.equal(body.data_type, 'JSON');
  assert.equal(body.access_token, 'asd78172s8ds9a921j9qqwda12312w1w21211');
  assert.equal(body.sign, sign);
  assert.match(sign, /^[0-9A-F]{32}$/);
});

test('buildPddRequestBody 不传 accessToken 时不注入该字段', () => {
  const { body } = buildPddRequestBody('pdd.time.get', {}, {
    clientId: 'app123',
    clientSecret: 'sec',
    timestamp: 1700000000,
  });
  assert.equal('access_token' in body, false);
  assert.equal(body.type, 'pdd.time.get');
});

test('网关地址与官方文档一致', () => {
  assert.equal(PDD_GATEWAY, 'https://gw-api.pinduoduo.com/api/router');
});
