// The published API contract (OpenAPI 3.1), generated from the same field list the format
// checker uses (WORK_ORDER_FIELDS), so the document and the real responses cannot drift apart.

import { WORK_ORDER_FIELDS, SCHEMA_VERSION } from './workOrderFeed.js';
import { RESPONSE_CODES } from '../locateTickets.js';
import { BODIES } from './workOrderWrites.js';

/** A request body schema straight from the list the endpoint checks against. */
function bodySchema(spec) {
  const properties = {};
  const required = [];
  for (const [field, type] of Object.entries(spec)) {
    const optional = type.endsWith('?');
    const base = optional ? type.slice(0, -1) : type;
    properties[field] = base === 'array' ? { type: 'array', items: { type: 'string' } } : { type: base };
    if (!optional) required.push(field);
  }
  properties.actor.description = 'The person or process acting; recorded in the audit trail with the calling system.';
  return { type: 'object', additionalProperties: false, required, properties };
}

const etagHeader = { ETag: { description: 'The work order version, e.g. "v3". Send it back as If-Match to change the work order.', schema: { type: 'string' } } };
const ifMatch = { name: 'If-Match', in: 'header', required: true, schema: { type: 'string', example: '"v3"' }, description: 'The ETag from your last read. Refused with 412 if the work order has changed since.' };
const idempotencyKey = { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Send the same key to retry safely: a repeat returns the first work order (200, Idempotent-Replayed: true).' };
const writeOk = (status, description) => ({
  [status]: { description, headers: etagHeader, content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkOrderWriteResult' } } } },
});
const writeErrors = {
  400: { description: 'The body or headers break the contract, or a work order rule (e.g. a location is required)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  403: { description: 'Valid key, but it does not have work_orders:write', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  503: { description: 'Database or audit trail unavailable; retry later', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
};
const changeErrors = {
  ...writeErrors,
  404: { description: 'No such work order' },
  409: { description: 'Not allowed in its current state (e.g. already completed)' },
  412: { description: 'The work order changed since you read it. The body has the current work order; its ETag is in the header.', headers: etagHeader },
  428: { description: 'If-Match was not sent' },
};

function jsonType(spec) {
  const optional = spec.endsWith('?');
  const base = optional ? spec.slice(0, -1) : spec;
  return optional ? { type: [base, 'null'] } : { type: base };
}

const location = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'address', 'latitude', 'longitude'],
  properties: { text: jsonType('string?'), address: jsonType('string?'), latitude: jsonType('number?'), longitude: jsonType('number?') },
};
const asset = {
  type: 'object',
  additionalProperties: false,
  required: ['asset_id', 'asset_type', 'name', 'attributes'],
  properties: { asset_id: jsonType('string'), asset_type: jsonType('string?'), name: jsonType('string?'), attributes: jsonType('object?') },
};

function workOrderSchema() {
  const properties = {};
  for (const [field, spec] of Object.entries(WORK_ORDER_FIELDS)) {
    if (field === 'location') properties[field] = { $ref: '#/components/schemas/Location' };
    else if (field === 'assets') properties[field] = { type: 'array', items: { $ref: '#/components/schemas/Asset' } };
    else properties[field] = jsonType(spec);
    if (field.endsWith('_at')) properties[field].format = 'date-time';
  }
  return { type: 'object', additionalProperties: false, required: Object.keys(WORK_ORDER_FIELDS), properties };
}

const page = (extra = {}) => ({
  type: 'object',
  required: ['schema_version', 'items', ...Object.keys(extra)],
  properties: {
    schema_version: { const: SCHEMA_VERSION },
    items: { type: 'array', items: { $ref: '#/components/schemas/WorkOrder' } },
    ...extra,
  },
});
const nextCursor = { next_cursor: { type: ['string', 'null'], description: 'Pass as ?cursor= to get the next page; null on the last page.' } };

const errors = {
  400: { description: 'Invalid parameters', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  503: { description: 'Database or audit trail unavailable; retry later. No partial data is ever returned.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
};
const ticketErrors = {
  ...errors,
  403: { description: 'Valid key, but it does not have locate_tickets:write', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  404: { description: 'No such locate ticket', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
};
const ticketId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const ticketOk = { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/LocateTicketResult' } } } } };
const jsonBody = (properties, required) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', required, properties } } },
});
const actor = { type: 'string', description: 'The person acting; recorded in the audit trail with the calling system.' };

// Locate ticket fields as stored (server/db.js, locate_tickets).
const TICKET_FIELDS = {
  id: 'string', ticket_number: 'string', ticket_type: 'string', status: 'string', excavator_name: 'string',
  work_description: 'string', dig_address: 'string', latitude: 'number?', longitude: 'number?', received_at: 'string',
  due_at: 'string', locator_notes: 'string?', marking_details: 'string?', work_order_id: 'string?', response_code: 'string?',
  response_note: 'string?', responded_at: 'string?', completed_at: 'string?', created_at: 'string', updated_at: 'string',
};

const limit = { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } };
const cursor = { name: 'cursor', in: 'query', schema: { type: 'string' } };
const ok = (schemaRef) => ({ 200: { description: 'OK', content: { 'application/json': { schema: schemaRef } } }, ...errors });

export function openApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Herriman City Work Orders — read API',
      version: `${SCHEMA_VERSION}.0.0`,
      description: 'Read-only access to work order data for indexing and search engines (e.g. Madison AI). '
        + 'Every request needs an API key in the Authorization header and is recorded in the audit trail.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ apiKey: [] }],
    paths: {
      '/work-orders': {
        get: { summary: 'Every work order, oldest first, a page at a time', parameters: [limit, cursor], responses: ok({ $ref: '#/components/schemas/WorkOrderPage' }) },
        post: {
          summary: 'Create a work order (needs work_orders:write)',
          parameters: [idempotencyKey],
          requestBody: { required: true, content: { 'application/json': { schema: bodySchema(BODIES.create) } } },
          responses: { ...writeOk(201, 'Created'), ...writeOk(200, 'Repeat of an earlier request with the same Idempotency-Key'), ...writeErrors },
        },
      },
      '/work-orders/{id}/complete': {
        post: {
          summary: 'Complete a work order (needs work_orders:write)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, ifMatch],
          requestBody: { required: true, content: { 'application/json': { schema: bodySchema(BODIES.complete) } } },
          responses: { ...writeOk(200, 'Completed'), ...changeErrors },
        },
      },
      '/work-orders/changes': {
        get: {
          summary: 'Work orders created or changed after a time, for incremental re-indexing',
          parameters: [{ name: 'since', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } }, limit, cursor],
          responses: ok({ $ref: '#/components/schemas/WorkOrderPage' }),
        },
      },
      '/work-orders/search': {
        get: {
          summary: 'Keyword search over title, description, work type, location and address',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2 } }, limit],
          responses: ok({ $ref: '#/components/schemas/SearchResult' }),
        },
      },
      '/work-orders/{id}': {
        get: {
          summary: 'One work order',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'OK', headers: etagHeader, content: { 'application/json': { schema: { $ref: '#/components/schemas/SingleWorkOrder' } } } },
            ...errors,
            404: { description: 'No such work order' },
          },
        },
        patch: {
          summary: 'Change a work order (needs work_orders:write)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, ifMatch],
          requestBody: { required: true, content: { 'application/json': { schema: bodySchema(BODIES.update) } } },
          responses: { ...writeOk(200, 'Changed'), ...changeErrors },
        },
      },
      '/locate-tickets/{id}': {
        get: { summary: 'View a locate ticket (needs locate_tickets:write)', parameters: [ticketId], responses: { ...ticketOk, ...ticketErrors } },
        patch: {
          summary: 'Update a ticket\'s working details',
          parameters: [ticketId],
          requestBody: jsonBody({
            actor,
            status: { const: 'in_progress' },
            locator_notes: { type: ['string', 'null'] },
            marking_details: { type: ['string', 'null'] },
            work_order_id: { type: ['string', 'null'] },
          }, ['actor']),
          responses: { ...ticketOk, ...ticketErrors, 409: { description: 'The ticket is completed' } },
        },
      },
      '/locate-tickets/{id}/respond': {
        post: {
          summary: 'Answer the one-call centre and send the answer',
          parameters: [ticketId],
          requestBody: jsonBody({
            actor,
            code: { type: 'string', enum: Object.keys(RESPONSE_CODES), description: 'PLACEHOLDER codes until the official ones are known' },
            note: { type: ['string', 'null'] },
          }, ['actor', 'code']),
          responses: { ...ticketOk, ...ticketErrors, 409: { description: 'The ticket is completed' } },
        },
      },
      '/locate-tickets/{id}/complete': {
        post: {
          summary: 'Complete a ticket once its final answer has reached the one-call centre',
          parameters: [ticketId],
          requestBody: jsonBody({ actor }, ['actor']),
          responses: { ...ticketOk, ...ticketErrors, 409: { description: 'Not answered yet, answer not delivered, needs more time, or already completed' } },
        },
      },
    },
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer hwo_…' } },
      schemas: {
        WorkOrder: workOrderSchema(),
        Location: location,
        Asset: asset,
        WorkOrderPage: page(nextCursor),
        SearchResult: page({ query: { type: 'string' } }),
        WorkOrderWriteResult: {
          type: 'object', required: ['schema_version', 'item'],
          properties: {
            schema_version: { const: SCHEMA_VERSION },
            item: { $ref: '#/components/schemas/WorkOrder' },
            meta: { type: 'object', properties: { gis_sync: { type: 'string', enum: ['none', 'pending', 'synced'] } } },
          },
        },
        SingleWorkOrder: {
          type: 'object', required: ['schema_version', 'item'],
          properties: { schema_version: { const: SCHEMA_VERSION }, item: { $ref: '#/components/schemas/WorkOrder' } },
        },
        LocateTicket: {
          type: 'object',
          required: Object.keys(TICKET_FIELDS),
          properties: Object.fromEntries(Object.entries(TICKET_FIELDS).map(([f, spec]) => [f, jsonType(spec)])),
        },
        LocateTicketResult: {
          type: 'object',
          required: ['item'],
          properties: {
            item: { $ref: '#/components/schemas/LocateTicket' },
            delivery: { type: 'string', enum: ['none', 'pending', 'delivered'] },
            delivery_failures: { type: 'array', items: { type: 'object' } },
          },
        },
        Error: {
          type: 'object', required: ['error', 'message'],
          properties: { error: { type: 'string' }, message: { type: 'string' }, problems: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  };
}
