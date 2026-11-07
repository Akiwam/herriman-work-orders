// STORY-009 — vendor data contracts: each vendor gets exactly its own fields, checked before sending.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../server/db.js';
import { createWorkOrder, getWorkOrder, ValidationError, NotFoundError } from '../server/workOrders.js';
import {
  VENDORS, PERSONAL_FIELDS, getContract, validateForVendor, toVendorRecord, describeVendors, ContractMismatchError,
} from '../server/vendors.js';
import { WORK_ORDER_FIELDS } from '../server/api/workOrderFeed.js';

async function aWorkOrder() {
  const db = openDatabase();
  const wo = await createWorkOrder(db, {
    title: 'Water leak outside 12 Main St - call Mrs Jones on 801-555-0101',
    description: 'Resident reports water pooling', work_type: 'water_leak', location_text: 'Front yard of the Jones house', created_by: 'clerk-1',
  });
  return { db, row: getWorkOrder(db, wo.id) };
}

test('the three vendors named in REQ-055 each have a one-way contract', () => {
  assert.deepEqual(Object.keys(VENDORS), ['madison_ai', 'lama', 'sprypoint']);
  for (const v of describeVendors()) {
    assert.match(v.direction, /one-way/);
    assert.ok(v.contracts.length >= 1);
  }
  assert.equal(getContract('madison_ai').status, 'agreed');
  assert.equal(getContract('lama').status, 'proposed', 'proposed until Lama confirms (REQ-054)');
  assert.equal(getContract('sprypoint').status, 'proposed');
});

test('Madison AI gets the full published read format it already uses', async () => {
  const { db, row } = await aWorkOrder();
  const record = toVendorRecord(db, 'madison_ai', 1, row);
  assert.deepEqual(Object.keys(record).sort(), Object.keys(WORK_ORDER_FIELDS).sort());
  assert.deepEqual(validateForVendor('madison_ai', 1, record), []);
});

test('Lama and SpryPoint get only their own minimal fields, and never anything that can carry personal details', async () => {
  const { db, row } = await aWorkOrder();
  for (const vendor of ['lama', 'sprypoint']) {
    const record = toVendorRecord(db, vendor, 1, row);
    assert.deepEqual(Object.keys(record).sort(), [...getContract(vendor).fields].sort());
    // "location.text" is nested in the full format; the minimal format has no location object or text at all.
    for (const personal of PERSONAL_FIELDS) {
      const field = personal.split('.').at(-1);
      assert.ok(!(field in record) && !('location' in record), `${vendor} must not get ${personal}`);
    }
    const text = JSON.stringify(record);
    assert.doesNotMatch(text, /Jones|801-555|Resident|Front yard/, `${vendor} receives no free text`);
    assert.equal(record.status, 'open');
    assert.deepEqual(record.asset_ids, []);
  }
});

test('a record that does not match the contract is caught, with every problem listed', () => {
  const problems = validateForVendor('lama', 1, {
    id: 'wo-1', work_type: 'water_leak', status: 7, address: null, latitude: null, longitude: null,
    asset_ids: [], created_at: 'yesterday', updated_at: '2026-11-06T10:00:00Z', completed_at: null, title: 'leaked a title',
  });
  assert.deepEqual(problems.sort(), [
    'item.created_at must be an ISO date-time',
    'item.priority is missing',
    'item.status must be string',
    'item.title is not part of this vendor\'s contract',
  ].sort());
});

test('our own data that would break a contract is refused rather than sent', async () => {
  const { db, row } = await aWorkOrder();
  const damaged = { ...row, created_at: 'not a date' };
  assert.throws(() => toVendorRecord(db, 'sprypoint', 1, damaged), (err) => err instanceof ContractMismatchError && /created_at must be an ISO date-time/.test(err.message));
});

test('an unknown vendor or contract version is refused, naming what exists', () => {
  assert.throws(() => getContract('scada'), (err) => err instanceof NotFoundError && /Vendors: madison_ai, lama, sprypoint/.test(err.message));
  assert.throws(() => getContract('toString'), NotFoundError, 'only real vendors, not object properties');
  assert.throws(() => getContract('lama', 2), (err) => err instanceof ValidationError && /available: 1/.test(err.problems[0]));
  assert.throws(() => getContract('lama', 'one'), ValidationError);
});
