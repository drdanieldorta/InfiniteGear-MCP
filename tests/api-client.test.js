import test from 'node:test';
import assert from 'node:assert/strict';
import { executeOperation } from '../src/api-client.js';
import { operationsFromDocument } from '../src/catalog.js';
import { validateConfig } from '../src/config.js';
import { document, mockApi, mockConfig } from './fixture.js';

const operations = operationsFromDocument(document);
const find = id => operations.find(operation => operation.id === id);

test('sends bearer credentials only to configured API, serializes pagination/arrays and encoded IDs', async t => {
  const api = await mockApi(); t.after(api.close);
  const config = mockConfig(api.url);
  assert.equal((await executeOperation(find('list_contacts'), { query: { pageSize: 1, tags: ['a b', 'c'] } }, config)).status, 200);
  assert.equal(api.calls[0].url, '/core/v1/contact?pageSize=1&tags=a+b&tags=c');
  assert.equal(api.calls[0].headers.authorization, `Bearer ${config.apiToken}`);
  await executeOperation(find('get_contact'), { path: { id: 'a/b?c#d' } }, config);
  assert.equal(api.calls[1].url, '/core/v1/contact/a%2Fb%3Fc%23d');
  await assert.rejects(executeOperation(find('get_contact'), { path: { id: '..' } }, config), /inválido/);
  assert.equal(api.calls.length, 2);
});

test('validates required fields and blocks writes before any request; allows explicit write mode', async t => {
  const api = await mockApi(); t.after(api.close);
  const config = mockConfig(api.url);
  await assert.rejects(executeOperation(find('create_contact'), { body: { name: 'Example' } }, config), /desativadas/);
  await assert.rejects(executeOperation(find('create_contact'), { body: {} }, { ...config, allowWrites: true }), /required/);
  assert.equal(api.calls.length, 0);
  const result = await executeOperation(find('create_contact'), { body: { name: 'Example' } }, { ...config, allowWrites: true });
  assert.equal(result.status, 201);
  assert.deepEqual(api.calls[0].body, { name: 'Example' });
});

test('partner routes require and use a separate token', async t => {
  const api = await mockApi(); t.after(api.close);
  const config = mockConfig(api.url);
  await assert.rejects(executeOperation(find('list_accounts'), {}, { ...config, partnerToken: '' }), /parceiro/);
  assert.equal(api.calls.length, 0);
  await executeOperation(find('list_accounts'), {}, config);
  assert.equal(api.calls[0].headers.authorization, `Bearer ${config.partnerToken}`);
});

test('never follows credential-bearing redirects', async t => {
  const destination = await mockApi(); t.after(destination.close);
  const api = await mockApi((_request, response) => { response.writeHead(302, { Location: destination.url }); response.end(); }); t.after(api.close);
  await assert.rejects(executeOperation(find('list_contacts'), {}, mockConfig(api.url)), /redirecionamento/);
  assert.equal(destination.calls.length, 0);
});

test('reports rate limiting without retrying or exposing response secrets', async t => {
  const api = await mockApi((_request, response) => { response.writeHead(429, { 'Retry-After': '12' }); response.end('test-account-secret'); }); t.after(api.close);
  await assert.rejects(executeOperation(find('list_contacts'), {}, mockConfig(api.url)), error => /HTTP 429/.test(error.message) && /12/.test(error.message) && !/test-account-secret/.test(error.message));
  assert.equal(api.calls.length, 1);
});

test('redacts accidental credential echoes from successful API responses', async t => {
  const api = await mockApi((_request, response) => { response.end(JSON.stringify({ value: 'test-account-secret' })); }); t.after(api.close);
  const result = await executeOperation(find('list_contacts'), {}, mockConfig(api.url));
  assert.equal(result.data.value, '[segredo oculto]');
});

test('does not accept documentation URLs, insecure external URLs or URL credentials', () => {
  for (const apiUrl of ['https://infinitegear.readme.io', 'http://api.example.com', 'https://user:password@example.com', 'https://example.com?secret=1']) assert.throws(() => validateConfig({ apiUrl }));
});

test('honors explicit anonymous operations and combines API-key cookies with parameter cookies', async t => {
  const api = await mockApi(); t.after(api.close);
  const config = mockConfig(api.url);
  const anonymous = { ...find('list_contacts'), authScheme: { type: 'none' } };
  await executeOperation(anonymous, {}, { ...config, apiToken: '' });
  assert.equal(api.calls[0].headers.authorization, undefined);
  const cookieOperation = {
    ...find('list_contacts'), authScheme: { type: 'apiKey', in: 'cookie', name: 'access' },
    parameters: [{ in: 'cookie', name: 'view', schema: { type: 'string' } }],
    schema: { type: 'object', properties: { cookies: { type: 'object', properties: { view: { type: 'string' } } } } },
  };
  await executeOperation(cookieOperation, { cookies: { view: 'compact' } }, config);
  assert.equal(api.calls[1].headers.cookie, 'view=compact; access=test-account-secret');
});

test('explains structured field validation errors without returning echoed credentials or URLs', async t => {
  const api = await mockApi((_request, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ title: 'Dados inválidos', errors: { name: ['Informe o nome.'], apiToken: ['test-account-secret'] }, detail: 'Bearer unexpected-private-value em https://example.invalid/?signed=private' }));
  }); t.after(api.close);
  await assert.rejects(executeOperation(find('list_contacts'), {}, mockConfig(api.url)), error => {
    assert.match(error.message, /name: Informe o nome/);
    assert.match(error.message, /HTTP 400/);
    assert(!/test-account-secret|unexpected-private-value|signed=private/.test(error.message));
    return true;
  });
});
