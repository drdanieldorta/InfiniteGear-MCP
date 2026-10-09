import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeBody, encodeHeaderValue, encodePathValue, serializeQuery } from '../src/serialization.js';

function query(parameter, value) {
  const url = new URL('https://example.invalid/resource');
  serializeQuery(url, { name: 'color', ...parameter }, value);
  return [...url.searchParams];
}

function operation(content, required = true) {
  return { requestBody: { required, content } };
}

test('serializes all simple, label and matrix path expansions', () => {
  const entries = [
    ['simple', false, 'blue', 'blue'],
    ['simple', false, ['blue', 'black'], 'blue,black'],
    ['simple', true, ['blue', 'black'], 'blue,black'],
    ['simple', false, { R: 100, G: 200 }, 'R,100,G,200'],
    ['simple', true, { R: 100, G: 200 }, 'R=100,G=200'],
    ['label', false, 'blue', '.blue'],
    ['label', false, ['blue', 'black'], '.blue,black'],
    ['label', true, ['blue', 'black'], '.blue.black'],
    ['label', false, { R: 100, G: 200 }, '.R,100,G,200'],
    ['label', true, { R: 100, G: 200 }, '.R=100.G=200'],
    ['matrix', false, 'blue', ';color=blue'],
    ['matrix', false, ['blue', 'black'], ';color=blue,black'],
    ['matrix', true, ['blue', 'black'], ';color=blue;color=black'],
    ['matrix', false, { R: 100, G: 200 }, ';color=R,100,G,200'],
    ['matrix', true, { R: 100, G: 200 }, ';R=100;G=200'],
  ];
  for (const [style, explode, value, expected] of entries) {
    assert.equal(encodePathValue({ name: 'color', style, explode }, value), expected, `${style}/${explode}/${JSON.stringify(value)}`);
  }
  assert.equal(encodePathValue({ name: 'id' }, 'a/b?c#d'), 'a%2Fb%3Fc%23d');
  assert.throws(() => encodePathValue({ name: 'id' }, '..'), /inválido/);
  assert.throws(() => encodePathValue({ name: 'id' }, undefined), /Preencha/);
  assert.throws(() => encodePathValue({ name: 'id' }, { nested: {} }), /aninhados/);
});

test('serializes query arrays and objects according to form/delimited/deepObject styles', () => {
  assert.deepEqual(query({}, ['blue', 'black']), [['color', 'blue'], ['color', 'black']]);
  assert.deepEqual(query({ explode: false }, ['blue', 'black']), [['color', 'blue,black']]);
  assert.deepEqual(query({}, { R: 100, G: 200 }), [['R', '100'], ['G', '200']]);
  assert.deepEqual(query({ explode: false }, { R: 100, G: 200 }), [['color', 'R,100,G,200']]);
  assert.deepEqual(query({ style: 'spaceDelimited' }, ['blue', 'black']), [['color', 'blue black']]);
  assert.deepEqual(query({ style: 'pipeDelimited' }, ['blue', 'black']), [['color', 'blue|black']]);
  assert.deepEqual(query({ style: 'deepObject', explode: true }, { R: 100, G: 200 }), [['color[R]', '100'], ['color[G]', '200']]);
  assert.deepEqual(query({}, ''), [['color', '']]);
  assert.deepEqual(query({}, null), [['color', '']]);
  assert.deepEqual(query({}, undefined), []);
  assert.throws(() => query({ style: 'deepObject' }, { nested: { a: 1 } }), /aninhados/);
  assert.throws(() => query({ style: 'deepObject', explode: false }, { a: 1 }), /explode/);
  assert.throws(() => query({ style: 'spaceDelimited', explode: true }, ['a']), /explode/);
  assert.throws(() => query({ allowReserved: true }, 'a&admin=true'), /allowReserved/);
});

test('serializes JSON-content parameters as JSON rather than form fields', () => {
  const parameter = { content: { 'application/json': { schema: { type: 'object' } } } };
  const value = { nested: { active: true }, ids: ['a', 'b'] };
  assert.deepEqual(query(parameter, value), [['color', JSON.stringify(value)]]);
  assert.equal(encodePathValue({ name: 'filter', ...parameter }, value), encodeURIComponent(JSON.stringify(value)));
  assert.equal(encodeHeaderValue(parameter, value), JSON.stringify(value));
  assert.throws(() => query({ content: { 'application/xml': {} } }, '<xml/>'), /não suportado/);
});

test('serializes simple headers correctly and rejects header injection', () => {
  assert.equal(encodeHeaderValue({}, ['a', 'b']), 'a,b');
  assert.equal(encodeHeaderValue({}, { R: 100, G: 200 }), 'R,100,G,200');
  assert.equal(encodeHeaderValue({ explode: true }, { R: 100, G: 200 }), 'R=100,G=200');
  assert.throws(() => encodeHeaderValue({}, 'ok\r\nX-Injected: true'), /quebras/);
  assert.throws(() => encodeHeaderValue({ style: 'form' }, 'value'), /não suportado/);
});

test('validates the selected media schema before body encoding', () => {
  const contract = operation({
    'application/json': { schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false } },
    'text/plain': { schema: { type: 'string', minLength: 1 } },
  });
  const headers = new Headers();
  assert.equal(encodeBody(contract, { body: { label: 'Example' } }, headers), '{"label":"Example"}');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.throws(() => encodeBody(contract, { body: { label: 'Example' }, contentType: 'text/plain' }, new Headers()), /tipo de conteúdo selecionado/);
  assert.throws(() => encodeBody(contract, { body: 'Example', contentType: 'application/json' }, new Headers()), /tipo de conteúdo selecionado/);
  assert.throws(() => encodeBody(contract, { body: 'Example', contentType: 'image/png' }, new Headers()), /não está declarado/);
  assert.throws(() => encodeBody(contract, {}, new Headers()), /obrigatório/);
  assert.equal(encodeBody(operation({}, false), {}, new Headers()), undefined);
});

test('encodes form-urlencoded fields using their individual encoding rules', () => {
  const contract = operation({ 'application/x-www-form-urlencoded': {
    schema: { type: 'object' },
    encoding: { tags: { style: 'pipeDelimited', explode: false }, filter: { style: 'deepObject', explode: true } },
  } });
  const headers = new Headers();
  const body = encodeBody(contract, { body: { tags: ['a', 'b'], filter: { active: true }, title: 'Example name' } }, headers);
  assert.deepEqual([...body], [['tags', 'a|b'], ['filter[active]', 'true'], ['title', 'Example name']]);
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
});

test('encodes multipart refs/allOf, binary bytes, JSON parts and repeated arrays exactly', async () => {
  const original = Buffer.from([0, 255, 10, 13, 42]);
  const schema = {
    $defs: {
      Binary: { type: 'string', contentEncoding: 'base64' },
      Metadata: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      Fields: { type: 'object', properties: { file: { $ref: '#/$defs/Binary' }, metadata: { $ref: '#/$defs/Metadata' }, tags: { type: 'array', items: { type: 'string' } } } },
    },
    allOf: [{ $ref: '#/$defs/Fields' }, { required: ['file', 'metadata'] }],
  };
  const contract = operation({ 'multipart/form-data': { schema, encoding: { file: { contentType: 'image/png' } } } });
  const headers = new Headers();
  const body = encodeBody(contract, { body: { file: original.toString('base64'), metadata: { label: 'Example' }, tags: ['one', 'two'] } }, headers);
  assert.ok(Buffer.isBuffer(body));
  assert.match(headers.get('content-type'), /^multipart\/form-data; boundary=infinitegear-/);
  const parsed = await new Response(body, { headers }).formData();
  assert.deepEqual(Buffer.from(await parsed.get('file').arrayBuffer()), original);
  assert.equal(parsed.get('file').type, 'image/png');
  assert.equal(parsed.get('metadata'), '{"label":"Example"}');
  assert.deepEqual(parsed.getAll('tags'), ['one', 'two']);
  assert.match(body.toString('latin1'), /name="metadata"\r\nContent-Type: application\/json\r\n/);
  assert.throws(() => encodeBody(contract, { body: { file: 'invalid base64!', metadata: { label: 'Example' } } }, new Headers()), /base64/);
});

test('rejects ambiguous or unrepresentable multipart encoding instead of sending wrong bytes', () => {
  const body = { upload: Buffer.from('Example').toString('base64') };
  const ambiguous = operation({ 'multipart/form-data': { schema: { type: 'object', properties: { upload: { anyOf: [{ type: 'string', contentEncoding: 'base64' }, { type: 'string' }] } } } } });
  assert.throws(() => encodeBody(ambiguous, { body }, new Headers()), /ambíguas/);
  const headers = operation({ 'multipart/form-data': { schema: { type: 'object' }, encoding: { upload: { headers: { 'X-Custom': { schema: { type: 'string' } } } } } } });
  assert.throws(() => encodeBody(headers, { body }, new Headers()), /Cabeçalhos personalizados/);
  const conditional = operation({ 'multipart/form-data': { schema: { type: 'object', if: { required: ['upload'] }, then: { properties: { upload: { type: 'string', contentEncoding: 'base64' } } } } } });
  assert.throws(() => encodeBody(conditional, { body }, new Headers()), /condicionais/);
});

test('encodes opaque binary content only from validated canonical base64', () => {
  const contract = operation({ 'application/octet-stream': { schema: { $ref: '#/$defs/Bytes', $defs: { Bytes: { type: 'string', contentEncoding: 'base64' } } } } });
  const headers = new Headers();
  assert.deepEqual(encodeBody(contract, { body: 'AAH/' }, headers), Buffer.from([0, 1, 255]));
  assert.equal(headers.get('content-type'), 'application/octet-stream');
  assert.throws(() => encodeBody(contract, { body: 'Zh==' }, new Headers()), /base64 válida/);
  assert.throws(() => encodeBody(operation({ 'application/xml': { schema: { type: 'object' } } }), { body: {} }, new Headers()), /não suportado/);
});
