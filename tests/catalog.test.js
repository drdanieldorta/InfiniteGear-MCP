import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { importOpenApi, loadCatalog, operationsFromDocument } from '../src/catalog.js';

// Deliberately fictional contract: these routes are not claims about the production API.
function fixture() {
  return {
    openapi: '3.0.3',
    info: { title: 'Example fixture', version: '1.0.0' },
    servers: [{ url: 'https://example.invalid/core' }],
    security: [{ token: [] }],
    components: {
      securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Item: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', minLength: 1 },
            description: { type: 'string' },
            examples: { type: 'array', items: { type: 'string' } },
            child: { $ref: '#/components/schemas/Item' },
          },
          additionalProperties: false,
        },
      },
    },
    paths: {
      '/v1/example/{id}': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'getExample',
          parameters: [{ in: 'query', name: 'page', schema: { type: 'integer', minimum: 1 } }],
          responses: { 200: { description: 'Example fixture response' } },
        },
        put: {
          operationId: 'updateExample',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
          responses: { 200: { description: 'Example fixture response' } },
        },
      },
    },
  };
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'infinitegear-catalog-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('normalizes route prefixes, path/query arguments, auth and recursive request schemas', () => {
  const [get, put] = operationsFromDocument(fixture());
  assert.equal(get.path, '/core/v1/example/{id}');
  assert.equal(get.method, 'GET');
  assert.equal(get.readOnly, true);
  assert.deepEqual(get.authScheme, { type: 'bearer' });
  assert.deepEqual(get.schema.required, ['path']);
  assert.equal(put.readOnly, false);
  const validate = new Ajv2020({ strict: false }).compile(put.schema);
  assert.equal(validate({ path: { id: '123' }, body: { title: 'Root', child: { title: 'Child' } } }), true);
  assert.equal(validate({ path: { id: '123' }, body: { description: 'Missing title' } }), false);
  assert.equal(validate({ body: { title: 'Missing route id' } }), false);
  const validateBody = new Ajv2020({ strict: false }).compile(put.requestBody.content['application/json'].schema);
  assert.equal(validateBody({ title: 'Root', child: { title: 'Child' } }), true);
  assert.equal(validateBody({ child: {} }), false);
});

test('uses operation override of shared parameters and preserves serialization metadata', () => {
  const document = fixture();
  document.paths['/v1/example/{id}'].parameters.push({ in: 'query', name: 'tags', schema: { type: 'string' } });
  document.paths['/v1/example/{id}'].get.parameters.push({ in: 'query', name: 'tags', style: 'pipeDelimited', explode: false, schema: { type: 'array', items: { type: 'string' } } });
  const [operation] = operationsFromDocument(document);
  assert.equal(operation.schema.properties.query.properties.tags.type, 'array');
  assert.equal(operation.parameters.find((parameter) => parameter.name === 'tags').style, 'pipeDelimited');
});

test('exposes parameter descriptions and explicit documentation links in the tool contract', () => {
  const document = fixture();
  const get = document.paths['/v1/example/{id}'].get;
  get.parameters[0].description = 'Número da página a ser obtida, começando em 1.';
  get['x-infinitegear-documentation-url'] = 'https://infinitegear.readme.io/reference/example';
  const [operation] = operationsFromDocument(document);
  assert.equal(operation.schema.properties.query.properties.page.description, get.parameters[0].description);
  assert.equal(operation.docsUrl, get['x-infinitegear-documentation-url']);
});

test('omits response-only properties and their requirements from nested request schemas', () => {
  const document = fixture();
  document.components.schemas.ResponseId = { type: 'string', readOnly: true };
  const item = document.components.schemas.Item;
  item.required.push('id', 'createdAt', 'referencedId', 'composedId');
  item.properties.id = { type: 'string', readOnly: true };
  item.properties.createdAt = { type: 'string', readOnly: true };
  item.properties.referencedId = { $ref: '#/components/schemas/ResponseId' };
  item.properties.composedId = { allOf: [{ $ref: '#/components/schemas/ResponseId' }] };
  const operation = operationsFromDocument(document)[1];
  const model = operation.schema.$defs.Model1;
  assert.deepEqual(model.required, ['title']);
  assert.deepEqual(Object.keys(model.properties), ['title', 'description', 'examples', 'child']);
  const validate = new Ajv2020({ strict: false }).compile(operation.schema);
  assert.equal(validate({ path: { id: '123' }, body: { title: 'Root', child: { title: 'Child' } } }), true);
  assert.equal(validate({ path: { id: '123' }, body: { title: 'Root', id: 'response-only' } }), false);
  assert.equal(item.properties.id.readOnly, true, 'conversion must not mutate source response schemas');
});

test('supports documented read-only POST operations without changing ordinary write behavior', () => {
  const document = fixture();
  const write = document.paths['/v1/example/{id}'].put;
  document.paths['/v1/example/filter'] = {
    post: { ...write, operationId: 'filterExample', 'x-infinitegear-read-only': true },
  };
  const operations = operationsFromDocument(document);
  assert.equal(operations.find(operation => operation.id === 'filterExample').readOnly, true);
  assert.equal(operations.find(operation => operation.id === 'updateExample').readOnly, false);
  document.paths['/v1/example/filter'].post['x-infinitegear-read-only'] = 'true';
  assert.throws(() => operationsFromDocument(document), /x-infinitegear-read-only deve/);
});

test('distinguishes partner routes, office hours and explicit auth overrides', () => {
  const document = fixture();
  document.paths = Object.fromEntries(['/v1/company', '/v1/company/officehours', '/v2/partner/report', '/v1/example'].map((route) => [route, { get: { responses: { 200: { description: 'OK' } }, ...(route.endsWith('/example') ? { 'x-infinitegear-auth': 'partner' } : {}) } }]));
  assert.deepEqual(operationsFromDocument(document).map((operation) => operation.auth), ['partner', 'account', 'partner', 'partner']);
});

test('allows explicit credential selection only when the documented operation accepts either token', () => {
  const document = fixture();
  document.paths['/v1/example/{id}'].put['x-infinitegear-auth'] = 'either';
  const [get, put] = operationsFromDocument(document);
  assert.equal(get.schema.properties.credential, undefined);
  assert.equal(put.auth, 'either');
  assert.deepEqual(put.schema.properties.credential.enum, ['account', 'partner']);
  const validate = new Ajv2020({ strict: false }).compile(put.schema);
  const args = { path: { id: '123' }, body: { title: 'Teste' } };
  assert.equal(validate(args), true);
  assert.equal(validate({ ...args, credential: 'account' }), true);
  assert.equal(validate({ ...args, credential: 'partner' }), true);
  assert.equal(validate({ ...args, credential: 'unknown' }), false);
});

test('respects API-key and anonymous security; rejects unsupported simultaneous auth', () => {
  const document = fixture();
  document.components.securitySchemes.token = { type: 'apiKey', in: 'header', name: 'X-Account-Key' };
  document.paths['/v1/example/{id}'].put.security = [];
  const [get, put] = operationsFromDocument(document);
  assert.deepEqual(get.authScheme, { type: 'apiKey', in: 'header', name: 'X-Account-Key' });
  assert.deepEqual(put.authScheme, { type: 'none' });
  document.security = [{ token: [], secondToken: [] }];
  assert.throws(() => operationsFromDocument(document), /Autenticação não suportada/);
});

test('supports OpenAPI 3.1 constraints and normalizes nullable/binary inputs', () => {
  const document = fixture();
  const body = document.paths['/v1/example/{id}'].put.requestBody.content['application/json'];
  body.schema = { type: 'object', properties: { amount: { type: 'number', minimum: 0, exclusiveMinimum: true, nullable: true }, file: { type: 'string', format: 'binary' } } };
  let operation = operationsFromDocument(document)[1];
  const amount = operation.schema.properties.body.properties.amount;
  assert.deepEqual(amount.type, ['number', 'null']);
  assert.equal(amount.exclusiveMinimum, 0);
  assert.equal(amount.minimum, undefined);
  assert.equal(operation.schema.properties.body.properties.file.contentEncoding, 'base64');
  document.openapi = '3.1.0';
  body.schema = { type: 'array', prefixItems: [{ type: 'string' }], items: false };
  operation = operationsFromDocument(document)[1];
  const validate = new Ajv2020({ strict: false }).compile(operation.schema);
  assert.equal(validate({ path: { id: '123' }, body: ['one'] }), true);
  assert.equal(validate({ path: { id: '123' }, body: ['one', 'two'] }), false);
});

test('rejects external references at runtime and ambiguous server prefixes', () => {
  const document = fixture();
  document.components.schemas.Item.properties.child.$ref = 'https://example.invalid/schema.json';
  assert.throws(() => operationsFromDocument(document), /Referências externas/);
  const ambiguous = fixture();
  ambiguous.servers.push({ url: 'https://example.invalid/another-prefix' });
  assert.throws(() => operationsFromDocument(ambiguous), /prefixos diferentes/);
});

test('keeps boolean JSON Schemas and Swagger 2 array serialization meaningful', () => {
  const document = fixture();
  document.openapi = '3.1.0';
  document.paths['/v1/example/{id}'].put.requestBody.content['application/json'].schema = false;
  assert.equal(operationsFromDocument(document)[1].schema.properties.body, false);
  const swagger = {
    swagger: '2.0', info: { title: 'Example fixture', version: '1.0.0' }, basePath: '/chat',
    paths: { '/example': { get: { parameters: [{ in: 'query', name: 'ids', type: 'array', items: { type: 'string' } }], responses: { 200: { description: 'OK' } } } } },
  };
  const [operation] = operationsFromDocument(swagger);
  assert.equal(operation.path, '/chat/example');
  assert.equal(operation.parameters[0].style, 'form');
  assert.equal(operation.parameters[0].explode, false);
});

test('imports local JSON, removes presentation metadata, preserves field names and loads valid output', async (t) => {
  const directory = await temporary(t);
  const input = path.join(directory, 'source.json');
  const output = path.join(directory, 'out');
  await writeFile(input, JSON.stringify(fixture()));
  const imported = await importOpenApi([input], output);
  assert.equal(imported[0].operations, 2);
  const saved = JSON.parse(await readFile(imported[0].path, 'utf8'));
  assert.equal(saved.info.title, 'InfiniteGear API');
  assert.equal(saved.servers, undefined);
  assert.equal(saved['x-infinitegear-base-path'], '/core');
  assert.deepEqual(Object.keys(saved.components.schemas.Item.properties), ['title', 'description', 'examples', 'child']);
  assert.equal(JSON.stringify(saved).includes('example.invalid'), false);
  const loaded = await loadCatalog(output);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].path, '/core/v1/example/{id}');
  assert.deepEqual(await importOpenApi([input], output), imported, 'same import is idempotent');
});

test('bundles explicit local YAML references but rejects HTTP references without fetching', async (t) => {
  const directory = await temporary(t);
  const input = path.join(directory, 'source.yaml');
  const output = path.join(directory, 'out');
  await writeFile(path.join(directory, 'model.yaml'), 'type: object\nproperties:\n  label:\n    type: string\n');
  await writeFile(input, `openapi: 3.0.3\ninfo:\n  title: Example fixture\n  version: '1.0'\npaths:\n  /example:\n    post:\n      requestBody:\n        content:\n          application/json:\n            schema:\n              $ref: './model.yaml'\n      responses:\n        '200':\n          description: OK\n`);
  await assert.rejects(loadCatalog(input), /Referências externas/);
  const imported = await importOpenApi([input], output);
  assert.equal((await loadCatalog(imported[0].path)).length, 1);
  const remote = fixture();
  remote.components.schemas.Item.properties.child.$ref = 'https://example.invalid/must-not-download.json';
  const remoteInput = path.join(directory, 'remote.json');
  await writeFile(remoteInput, JSON.stringify(remote));
  await assert.rejects(importOpenApi([remoteInput], output), /resolve|resolver|protocol|http/i);
  await assert.rejects(importOpenApi(['https://example.invalid/source.json'], output), /arquivos locais/);
});

test('reports missing custom catalogs and duplicate routes, while allowing empty directories', async (t) => {
  const directory = await temporary(t);
  await assert.rejects(loadCatalog(path.join(directory, 'missing.json')), /Não foi possível abrir/);
  assert.deepEqual(await loadCatalog(directory), []);
  await writeFile(path.join(directory, 'one.json'), JSON.stringify(fixture()));
  await writeFile(path.join(directory, 'two.json'), JSON.stringify(fixture()));
  await assert.rejects(loadCatalog(directory), /Operação duplicada/);
});

test('gives colliding operation IDs deterministic, distinct MCP names', async (t) => {
  const directory = await temporary(t);
  const document = fixture();
  document.paths['/v1/example/{id}'].put.operationId = 'getExample';
  // Duplicate operationId is invalid OpenAPI: use separate valid documents to simulate service catalogs.
  delete document.paths['/v1/example/{id}'].put;
  await writeFile(path.join(directory, 'core.json'), JSON.stringify(document));
  document.servers = [{ url: 'https://example.invalid/chat' }];
  await writeFile(path.join(directory, 'chat.json'), JSON.stringify(document));
  const loaded = await loadCatalog(directory);
  assert.equal(new Set(loaded.map((operation) => operation.name)).size, 2);
  assert.ok(loaded.every((operation) => /^[a-zA-Z0-9_-]{1,64}$/.test(operation.name)));
});
