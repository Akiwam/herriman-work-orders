// The published API contract (OpenAPI 3.1), generated from the same field list the format
// checker uses (WORK_ORDER_FIELDS), so the document and the real responses cannot drift apart.

import { WORK_ORDER_FIELDS, SCHEMA_VERSION } from './workOrderFeed.js';
import { RESPONSE_CODES } from '../locateTickets.js';
import { BODIES } from './workOrderWrites.js';
import { WORKFLOW_FIELDS, STEP_FIELDS } from './workflowRoutes.js';
import { SUBMISSION_FIELDS, REVIEW_FIELDS } from './vendorRoutes.js';
import { FORMATS as HEAT_MAP_FORMATS, STATUSES as HEAT_MAP_STATUSES, CELL_SIZE as HEAT_MAP_CELL } from '../heatMaps.js';
import { COMPLIANCE_VALUES, REVIEW_DECISIONS, MAX_DOCUMENTS, MAX_DOCUMENT_BYTES } from '../vendorSubmissions.js';

// Vendor request bodies. Field names come from the lists the endpoints enforce; this adds the types.
const VENDOR_FIELD_SCHEMAS = {
  requirement_id: { type: 'string', example: 'REQ-023', description: 'One of GET /vendor/requirements' },
  compliance: { type: 'string', enum: COMPLIANCE_VALUES },
  technical_approach: { type: 'string', minLength: 20, maxLength: 10000 },
  submission_key: { type: 'string', minLength: 8, maxLength: 100, description: 'Send the same key to retry safely; a repeat returns the first receipt.' },
  documents: {
    type: 'array',
    maxItems: MAX_DOCUMENTS,
    items: {
      type: 'object', required: ['filename', 'content_type', 'content_base64'], additionalProperties: false,
      properties: {
        filename: { type: 'string' },
        content_type: { type: 'string', enum: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'] },
        content_base64: { type: 'string', description: `At most ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB once decoded; the bytes must really be the declared type.` },
      },
    },
  },
  decision: { type: 'string', enum: REVIEW_DECISIONS },
  comment: { type: ['string', 'null'], description: 'Required when requesting changes.' },
};
const vendorBody = (fields, required) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required, properties: Object.fromEntries(fields.map((f) => [f, VENDOR_FIELD_SCHEMAS[f]])) } } },
});
const vendorErrors = {
  400: { description: 'Invalid data, an unknown field, or a document that is not what it claims to be' },
  401: { description: 'Missing or invalid API key' },
  403: { description: 'The key does not have the role this endpoint needs (vendor:submit or vendor:review)' },
  404: { description: 'No such item — or it belongs to another vendor' },
};
// Workflow bodies (STORY-006). Field names come from the lists the endpoint enforces; this adds the types.
const WORKFLOW_FIELD_SCHEMAS = {
  actor: { type: 'string', description: 'The administrator making the change; recorded in the audit trail with the calling system.' },
  key: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,40}$', description: 'Stays the same across versions, e.g. pothole_repair' },
  name: { type: 'string', minLength: 2, maxLength: 80 },
  work_type: { type: 'string', description: 'New work orders of this type follow the workflow; other types follow Standard.' },
  steps: { type: 'array', minItems: 2, maxItems: 30, description: 'The first step is where work orders start. Exactly one is final.', items: { $ref: '#/components/schemas/WorkflowStep' } },
};
const STEP_FIELD_SCHEMAS = {
  key: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,40}$' },
  name: { type: 'string' },
  next: { type: 'array', items: { type: 'string' }, description: 'Step keys it may move to. Empty only for the final step.' },
  final: { type: 'boolean', description: 'Reaching it completes the work order (which needs a note).' },
};
const workflowErrors = {
  401: { description: 'Missing or invalid API key' },
  403: { description: 'The key does not have workflows:admin' },
  503: { description: 'Database or audit trail unavailable; retry later' },
};
const workflowKey = { name: 'key', in: 'path', required: true, schema: { type: 'string' } };

const vendorId = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };

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
      '/work-orders/{id}/transition': {
        post: {
          summary: 'Move a work order to one of the next steps its workflow allows (needs work_orders:write)',
          description: 'The final step is reached by completing the work order, not by a transition. '
            + 'Work orders keep the workflow version they started on. meta.workflow in the response shows the new step and the next steps.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, ifMatch],
          requestBody: { required: true, content: { 'application/json': { schema: bodySchema(BODIES.transition) } } },
          responses: { ...writeOk(200, 'Moved'), ...changeErrors, 409: { description: 'Not a next step from where the work order is, the final step, or the work order is completed' } },
        },
      },
      '/work-orders/{id}/workflow': {
        get: {
          summary: 'Where a work order is in its workflow, and where it can go next',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { item: { $ref: '#/components/schemas/WorkflowPosition' } } } } } }, ...errors, 404: { description: 'No such work order' } },
        },
      },
      '/workflows': {
        get: { summary: 'Every workflow and its versions (needs work_orders:read)', responses: ok({ type: 'object' }) },
        post: {
          summary: 'Publish a workflow, or a new version of one (needs workflows:admin)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: WORKFLOW_FIELDS, properties: Object.fromEntries(WORKFLOW_FIELDS.map((f) => [f, WORKFLOW_FIELD_SCHEMAS[f]])) } } },
          },
          responses: {
            201: { description: 'Published as a new version' },
            200: { description: 'Identical to the active version; nothing changed (unchanged: true)' },
            400: { description: 'The body is not valid JSON or has no actor' },
            409: { description: 'Another workflow already covers this work type' },
            422: { description: 'The workflow could strand work orders or is malformed. problems lists every issue; nothing was saved.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            ...workflowErrors,
          },
        },
      },
      '/workflows/{key}': {
        get: { summary: 'The active version of a workflow, with its steps (needs work_orders:read)', parameters: [workflowKey], responses: { ...ok({ type: 'object' }), 404: { description: 'No active workflow with this key' } } },
      },
      '/workflows/{key}/retire': {
        post: {
          summary: 'Retire a workflow: new work orders of its type follow Standard; work already on it keeps it (needs workflows:admin)',
          parameters: [workflowKey],
          requestBody: jsonBody({ actor }, ['actor']),
          responses: { 200: { description: 'Retired' }, 404: { description: 'No active workflow with this key' }, 409: { description: 'Standard cannot be retired' }, ...workflowErrors },
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
      '/heat-maps': {
        get: {
          summary: 'A heat map of work orders per grid cell (needs heatmaps:read; never public)',
          description: 'Work orders are placed by their own coordinates, or the map pin a citizen gave. Those with neither are counted as unmapped. '
            + 'Only counts per cell are returned, never individual work orders. Every request is logged with its parameters.',
          parameters: [
            { name: 'format', in: 'query', schema: { type: 'string', enum: HEAT_MAP_FORMATS, default: 'geojson' } },
            { name: 'work_types', in: 'query', schema: { type: 'string' }, description: 'Comma-separated, e.g. pothole,streetlight' },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Created on or after' },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Created before' },
            { name: 'status', in: 'query', schema: { type: 'string', enum: HEAT_MAP_STATUSES, default: 'all' } },
            { name: 'cell_size_m', in: 'query', schema: { type: 'integer', minimum: HEAT_MAP_CELL.min, maximum: HEAT_MAP_CELL.max, default: HEAT_MAP_CELL.default } },
          ],
          responses: {
            200: {
              description: 'The heat map',
              content: {
                'application/geo+json': { schema: { type: 'object', description: 'FeatureCollection: one square Polygon per cell with count, share and by_type' } },
                'image/svg+xml': { schema: { type: 'string' } },
              },
            },
            400: { description: 'Invalid parameters' },
            401: { description: 'Missing or invalid API key' },
            403: { description: 'The key does not have heatmaps:read' },
            422: { description: 'Too detailed to draw (use larger cells or narrower filters), or drawing failed' },
            503: { description: 'Database unavailable; retry later' },
          },
        },
      },
      '/vendor/requirements': {
        get: { summary: 'The requirements vendors answer (vendor:submit or vendor:review)', responses: { 200: { description: 'OK' }, ...vendorErrors } },
      },
      '/vendor/submissions': {
        post: {
          summary: 'Submit a compliance answer and technical approach for one requirement (vendor:submit)',
          requestBody: vendorBody(SUBMISSION_FIELDS, ['requirement_id', 'compliance', 'technical_approach']),
          responses: {
            201: { description: 'Stored and confirmed; the receipt includes fingerprints of the submission and each document' },
            200: { description: 'Repeat of an earlier submission_key' },
            409: { description: 'An earlier revision is still waiting for review, or already approved' },
            ...vendorErrors,
          },
        },
      },
      '/vendor/submissions/{id}': {
        get: { summary: 'One submission (its vendor, or a reviewer)', parameters: [vendorId], responses: { 200: { description: 'OK' }, ...vendorErrors } },
      },
      '/vendor/submissions/{id}/review': {
        post: {
          summary: 'Approve or request changes (vendor:review)',
          parameters: [vendorId],
          requestBody: vendorBody(REVIEW_FIELDS, ['decision']),
          responses: { 200: { description: 'Reviewed' }, 409: { description: 'Already reviewed, or the reviewer is the submitting organisation' }, ...vendorErrors },
        },
      },
      '/vendor/summary': {
        get: { summary: "The calling vendor's status for every requirement (vendor:submit)", responses: { 200: { description: 'OK' }, ...vendorErrors } },
      },
      '/vendor/review-queue': {
        get: { summary: 'Everything waiting for review, oldest first, with overdue flags (vendor:review)', responses: { 200: { description: 'OK' }, ...vendorErrors } },
      },
      '/vendor/documents/{id}': {
        get: {
          summary: 'Download one document (its vendor, or a reviewer). Always sent as an attachment.',
          parameters: [vendorId],
          responses: { 200: { description: 'The exact bytes; X-Content-SHA256 carries their fingerprint' }, ...vendorErrors },
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
            meta: { type: 'object', properties: { gis_sync: { type: 'string', enum: ['none', 'pending', 'synced'] }, workflow: { $ref: '#/components/schemas/WorkflowPosition' } } },
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
        WorkflowStep: {
          type: 'object', additionalProperties: false, required: ['key', 'name', 'next'],
          properties: Object.fromEntries(STEP_FIELDS.map((f) => [f, STEP_FIELD_SCHEMAS[f]])),
        },
        WorkflowPosition: {
          type: 'object',
          properties: {
            work_order_id: { type: 'string' }, status: { type: 'string' }, workflow_key: { type: 'string' }, workflow_version: { type: 'integer' },
            workflow_name: { type: 'string' }, current_step: { type: 'string' }, current_step_name: { type: 'string' },
            step_entered_at: { type: ['string', 'null'], format: 'date-time' },
            next_steps: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } } },
            can_complete: { type: 'boolean' },
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
