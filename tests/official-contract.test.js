import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadCatalog } from '../src/catalog.js';
import { executeOperation, validateArguments } from '../src/api-client.js';
import { mockConfig } from './fixture.js';

// Real, bundled API contracts; every HTTP response below is simulated locally.
// These tests never use CRM credentials or send requests to the live service.
const operations = await loadCatalog();
const config = mockConfig('https://example.invalid');
const uuid = '12345678-1234-4234-8234-123456789abc';
const find = (method, path) => {
  const operation = operations.find(item => item.method === method && item.path === path);
  assert.ok(operation, `Missing documented operation: ${method} ${path}`);
  return operation;
};

function capture(response = { items: [] }) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), ...options });
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
}

test('bundles 119 indexed operations and integrated login with valid schemas and bearer authentication', () => {
  assert.equal(operations.length, 120);
  assert.equal(operations.filter(operation => !operation.path.startsWith('/auth/')).length, 119);
  assert.equal(new Set(operations.map(operation => operation.name)).size, 120);
  assert.equal(new Set(operations.map(operation => `${operation.method} ${operation.path}`)).size, 120);
  assert.deepEqual([...new Set(operations.map(operation => operation.path.split('/')[1]))].sort(), ['auth', 'chat', 'core', 'crm']);
  for (const operation of operations) {
    const ajv = new Ajv2020({ strict: false, validateFormats: true });
    addFormats(ajv);
    assert.doesNotThrow(() => ajv.compile(operation.schema), operation.path);
    assert.deepEqual(operation.authScheme, { type: 'bearer' }, operation.path);
    assert.match(operation.name, /^infinitegear_[a-zA-Z0-9_-]{1,51}$/);
    assert.ok(operation.description.length > 0);
    assert.match(operation.docsUrl, /^https:\/\/infinitegear\.readme\.io\//);
    if (operation.requestBody) assert.deepEqual(Object.keys(operation.requestBody.content), ['application/json']);
  }
});

test('contact listing keeps documented query names, arrays, pagination metadata and parameter descriptions', async () => {
  const operation = find('GET', '/core/v1/contact');
  const page = { items: [{ id: uuid, name: 'Contato de teste' }], pageNumber: 2, pageSize: 20, totalPages: 3, totalItems: 55, hasMorePages: true };
  const recorder = capture(page);
  const result = await executeOperation(operation, {
    query: { PageNumber: 2, PageSize: 20, IncludeDetails: ['Tags', 'CustomFields'], 'CreatedAt.After': '2026-01-01T00:00:00Z' },
  }, config, recorder);
  const [request] = recorder.requests;
  assert.equal(request.url.pathname, '/core/v1/contact');
  assert.equal(request.url.searchParams.get('PageNumber'), '2');
  assert.equal(request.url.searchParams.get('PageSize'), '20');
  assert.equal(request.url.searchParams.get('CreatedAt.After'), '2026-01-01T00:00:00Z');
  assert.deepEqual(request.url.searchParams.getAll('IncludeDetails'), ['Tags', 'CustomFields']);
  assert.equal(request.headers.get('Authorization'), `Bearer ${config.apiToken}`);
  assert.equal(request.redirect, 'manual');
  assert.deepEqual(result.data, page);
  assert.match(operation.schema.properties.query.properties.PageSize.description, /página/);
  assert.throws(() => validateArguments(operation, { query: { PageSize: 101 } }), /Revise os campos/);
  assert.throws(() => validateArguments(operation, { query: { 'CreatedAt.After': 'yesterday' } }), /Revise os campos/);
});

test('contact filtering remains available with writes disabled and serializes the documented JSON body', async () => {
  const operation = find('POST', '/core/v1/contact/filter');
  assert.equal(operation.readOnly, true);
  const recorder = capture();
  const body = { pageNumber: 1, pageSize: 25, name: 'Ana', tagNames: ['Cliente'], customFields: { categoria: 'A' }, metadata: { campanha: 'outubro' } };
  await executeOperation(operation, { body }, config, recorder);
  assert.equal(recorder.requests[0].method, 'POST');
  assert.equal(recorder.requests[0].headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(recorder.requests[0].body), body);
  assert.throws(() => validateArguments(operation, { body: { pageSize: 101 } }), /Revise os campos/);
});

test('contact creation and message sending use actual request models and enforce the write setting', async () => {
  const create = find('POST', '/core/v1/contact');
  const message = find('POST', '/chat/v1/send/text');
  const recorder = capture({ id: uuid });
  const body = { name: 'Contato de teste', phoneNumber: '5511999999999', email: null, options: { upsert: true }, metadata: { origem: 'teste', removida: null } };
  await assert.rejects(executeOperation(create, { body }, config, recorder), /alterações estão desativadas/);
  assert.equal(recorder.requests.length, 0);
  await executeOperation(create, { body }, { ...config, allowWrites: true }, recorder);
  assert.deepEqual(JSON.parse(recorder.requests[0].body), body);
  assert.throws(() => validateArguments(message, { body: { to: '5511999999999' } }), /required property 'text'/);
  assert.throws(() => validateArguments(message, { body: { text: '' } }), /Revise os campos/);
  const messageBody = { to: '5511999999999', text: 'Mensagem simulada de teste', sessionId: uuid };
  await executeOperation(message, { body: messageBody }, { ...config, allowWrites: true }, recorder);
  assert.equal(recorder.requests[1].url.pathname, '/chat/v1/send/text');
  assert.deepEqual(JSON.parse(recorder.requests[1].body), messageBody);
});

test('account management uses partner credentials while company office hours use account credentials', async () => {
  const recorder = capture();
  await executeOperation(find('GET', '/core/v1/company'), {}, config, recorder);
  await executeOperation(find('GET', '/core/v1/company/officehours'), {}, config, recorder);
  assert.equal(recorder.requests[0].headers.get('Authorization'), `Bearer ${config.partnerToken}`);
  assert.equal(recorder.requests[1].headers.get('Authorization'), `Bearer ${config.apiToken}`);
  await assert.rejects(executeOperation(find('GET', '/core/v1/company'), {}, { ...config, partnerToken: '' }, recorder), /token de parceiro/);
  assert.equal(recorder.requests.length, 2);
});

test('integrated login respects the write setting and accepts explicit or fallback credentials', async () => {
  const login = find('POST', '/auth/v1/login/authenticate');
  assert.equal(login.auth, 'either');
  assert.equal(login.readOnly, false);
  const body = { email: 'test@example.invalid' };
  const recorder = capture({ token: 'test-login-result' });
  await assert.rejects(executeOperation(login, { body }, config, recorder), /alterações estão desativadas/);
  const enabled = { ...config, allowWrites: true };
  await executeOperation(login, { body, credential: 'partner' }, enabled, recorder);
  await executeOperation(login, { body, credential: 'account' }, enabled, recorder);
  await executeOperation(login, { body }, { ...enabled, apiToken: '' }, recorder);
  assert.equal(recorder.requests[0].headers.get('Authorization'), `Bearer ${config.partnerToken}`);
  assert.equal(recorder.requests[1].headers.get('Authorization'), `Bearer ${config.apiToken}`);
  assert.equal(recorder.requests[2].headers.get('Authorization'), `Bearer ${config.partnerToken}`);
  assert.throws(() => validateArguments(login, { body, credential: 'other' }), /Revise os campos/);
});

test('panel operations require documented IDs and preserve current endpoint versions', async () => {
  const list = find('GET', '/crm/v2/panel/card');
  assert.throws(() => validateArguments(list, {}), /required property 'query'/);
  assert.throws(() => validateArguments(list, { query: { PanelId: 'not-a-uuid' } }), /Revise os campos/);
  const recorder = capture();
  await executeOperation(list, { query: { PanelId: uuid, Statuses: ['OPEN', 'WON'], PageSize: 10 } }, config, recorder);
  assert.equal(recorder.requests[0].url.searchParams.get('PanelId'), uuid);
  assert.deepEqual(recorder.requests[0].url.searchParams.getAll('Statuses'), ['OPEN', 'WON']);
  assert.equal(find('PUT', '/crm/v3/panel/card/{id}').readOnly, false);
  assert.equal(find('GET', '/chat/v2/session').readOnly, true);
  const create = find('POST', '/crm/v2/panel/card');
  assert.throws(() => validateArguments(create, { body: { title: 'Teste' } }), /required property 'stepId'/);
  assert.doesNotThrow(() => validateArguments(create, { body: { title: 'Teste', stepId: uuid, dueDate: null, monetaryAmount: 125.5 } }));
});
