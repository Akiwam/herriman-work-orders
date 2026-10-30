// The published API contract (OpenAPI 3.1), generated from the same field list the format
// checker uses (WORK_ORDER_FIELDS), so the document and the real responses cannot drift apart.

import { WORK_ORDER_FIELDS, SCHEMA_VERSION } from './workOrderFeed.js';

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
          responses: { ...ok({ $ref: '#/components/schemas/SingleWorkOrder' }), 404: { description: 'No such work order' } },
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
        SingleWorkOrder: {
          type: 'object', required: ['schema_version', 'item'],
          properties: { schema_version: { const: SCHEMA_VERSION }, item: { $ref: '#/components/schemas/WorkOrder' } },
        },
        Error: {
          type: 'object', required: ['error', 'message'],
          properties: { error: { type: 'string' }, message: { type: 'string' }, problems: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  };
}
