import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsFromDocument } from '../src/catalog.js';
import { uploadFile, UPLOAD_MAX_BYTES, UPLOAD_TOOL } from '../src/upload.js';
import { mockConfig } from './fixture.js';

// Synthetic service responses exercise the flow without real account access.
const operations = operationsFromDocument({
  openapi: '3.0.3', info: { title: 'InfiniteGear upload test', version: '1' },
  servers: [{ url: 'https://example.invalid/core' }],
  paths: { '/v2/file': {
    get: {
      parameters: ['Type', 'Name', 'MimeType'].map(name => ({ in: 'query', name, required: name !== 'MimeType', schema: { type: 'string' } })),
      responses: { 200: { description: 'Temporary file' } },
    },
    post: {
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tempFileId'], properties: { tempFileId: { type: 'string', format: 'uuid' } }, additionalProperties: false } } } },
      responses: { 200: { description: 'Registered file' } },
    },
  } },
});
const config = { ...mockConfig('https://api.example.invalid'), allowWrites: true };
const tempFileId = '01234567-89ab-4cde-8f01-23456789abcd';
const file = { id: '12345678-9abc-4def-8012-3456789abcde', name: 'contrato.pdf', size: 4 };
const signedUrl = 'https://wts-storage.s3.sa-east-1.amazonaws.com/file?X-Amz-Signature=private-upload-signature';
const args = { name: 'contrato.pdf', type: 'PDF', mimeType: 'application/pdf', contentBase64: Buffer.from([0, 1, 254, 255]).toString('base64') };

function transport({ metadata = { tempFileId, urlUpload: signedUrl }, storage, registration, onCall } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = { url: new URL(url), ...options };
    calls.push(call);
    onCall?.(call);
    if (options.method === 'GET') return Response.json(metadata);
    if (options.method === 'PUT') return storage ? storage(call) : new Response('', { status: 200 });
    if (options.method === 'POST') return registration ? registration(call) : Response.json(file);
    assert.fail('Unexpected method');
  };
  return { calls, fetchImpl };
}

test('uploads the exact bytes, isolates storage credentials, and registers the returned temporary ID', async () => {
  const mock = transport();
  const result = await uploadFile(args, config, operations, mock);
  assert.deepEqual(result, file);
  assert.deepEqual(mock.calls.map(call => call.method), ['GET', 'PUT', 'POST']);
  const [get, put, post] = mock.calls;
  assert.equal(get.url.pathname, '/core/v2/file');
  assert.equal(get.url.searchParams.get('Type'), 'PDF');
  assert.equal(get.url.searchParams.get('Name'), 'contrato.pdf');
  assert.equal(get.url.searchParams.get('MimeType'), 'application/pdf');
  assert.equal(get.headers.get('Authorization'), `Bearer ${config.apiToken}`);
  assert.equal(put.url.href, signedUrl);
  assert.deepEqual(put.body, Buffer.from([0, 1, 254, 255]));
  assert.deepEqual([...put.headers.entries()], [['content-type', 'application/pdf']]);
  assert.equal(put.redirect, 'manual');
  assert.ok(put.signal instanceof AbortSignal);
  assert.equal(post.headers.get('Authorization'), `Bearer ${config.apiToken}`);
  assert.deepEqual(JSON.parse(post.body), { tempFileId });
  assert.ok(!JSON.stringify(result).includes('private-upload-signature'));
});

test('omitted MIME does not invent storage headers and default type is UNDEFINED', async () => {
  const mock = transport();
  const { mimeType, type, ...minimal } = args;
  await uploadFile(minimal, config, operations, mock);
  assert.equal(mock.calls[0].url.searchParams.get('Type'), 'UNDEFINED');
  assert.equal(mock.calls[0].url.searchParams.has('MimeType'), false);
  assert.deepEqual([...mock.calls[1].headers.entries()], []);
});

test('disabled writes and missing catalog stages fail before requesting an upload URL', async () => {
  const mock = transport();
  await assert.rejects(uploadFile(args, { ...config, allowWrites: false }, operations, mock), /desativadas/);
  await assert.rejects(uploadFile(args, config, operations.slice(0, 1), mock), /catálogo/);
  assert.equal(mock.calls.length, 0);
  assert.equal(UPLOAD_TOOL.annotations.readOnlyHint, false);
  assert.equal(UPLOAD_TOOL.annotations.idempotentHint, false);
});

test('rejects file paths, unknown inputs, invalid MIME/type and noncanonical base64 before network', async () => {
  const mock = transport();
  const badValues = [
    { name: '/tmp/file.pdf' }, { name: 'C:\\file.pdf' }, { name: '..' }, { name: ' ' }, { name: 'bad\nname' },
    { path: '/etc/passwd' }, { mimeType: 'text/plain\r\nAuthorization: leaked' }, { type: 'UNKNOWN' },
    { contentBase64: 'AA' }, { contentBase64: 'AB==' }, { contentBase64: 'AA==\n' },
    { contentBase64: 'AA-_' }, { contentBase64: 'data:text/plain;base64,AA==' }, { contentBase64: '' },
  ];
  for (const bad of badValues) await assert.rejects(uploadFile({ ...args, ...bad }, config, operations, mock));
  assert.equal(mock.calls.length, 0);
});

test('enforces the local decoded byte limit including equally sized base64 padding groups', async () => {
  const mock = transport();
  const oversized = Buffer.alloc(UPLOAD_MAX_BYTES + 1).toString('base64');
  await assert.rejects(uploadFile({ ...args, contentBase64: oversized }, config, operations, mock), /limite local/);
  assert.equal(mock.calls.length, 0);
});

test('refuses unsafe storage destinations without making a PUT or exposing the signed URL', async () => {
  const invalidUrls = [
    'http://wts-storage.s3.sa-east-1.amazonaws.com/file?secret=private-upload-signature',
    'https://wts-storage.s3.sa-east-1.amazonaws.com.evil.invalid/file?secret=private-upload-signature',
    'https://wts-storage.s3.sa-east-1.amazonaws.com:444/file?secret=private-upload-signature',
    'https://user:password@wts-storage.s3.sa-east-1.amazonaws.com/file?secret=private-upload-signature',
    `${signedUrl}#fragment`, 'https://127.0.0.1/file?secret=private-upload-signature', 'not-a-url:private-upload-signature',
  ];
  for (const urlUpload of invalidUrls) {
    const mock = transport({ metadata: { tempFileId, urlUpload } });
    await assert.rejects(uploadFile(args, config, operations, mock), error => !error.message.includes('private-upload-signature'));
    assert.equal(mock.calls.length, 1);
  }
});

test('refuses incomplete metadata without sending file bytes', async () => {
  for (const metadata of [null, { urlUpload: signedUrl }, { tempFileId, urlUpload: null }, { tempFileId: 'invalid', urlUpload: signedUrl }]) {
    const mock = transport({ metadata });
    await assert.rejects(uploadFile(args, config, operations, mock), /identificador temporário/);
    assert.equal(mock.calls.length, 1);
  }
});

test('storage redirects and failures are discarded without registration, repetition or secret echoes', async () => {
  for (const status of [302, 403, 500]) {
    let cancelled = false;
    const mock = transport({ storage: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { Location: signedUrl } }) });
    await assert.rejects(uploadFile(args, config, operations, mock), error => /não foi registrado/.test(error.message) && !error.message.includes('private-upload-signature'));
    assert.equal(cancelled, true);
    assert.deepEqual(mock.calls.map(call => call.method), ['GET', 'PUT']);
  }
});

test('storage errors and timeouts cannot leak signed URLs or account credentials', async () => {
  for (const error of [new Error(`${signedUrl} ${config.apiToken}`), new DOMException(signedUrl, 'TimeoutError')]) {
    const mock = transport({ storage: () => { throw error; } });
    await assert.rejects(uploadFile(args, config, operations, mock), result => /Confira o resultado/.test(result.message) && !result.message.includes('private-upload-signature') && !result.message.includes(config.apiToken));
    assert.equal(mock.calls.length, 2);
  }
});

test('registration failure reports uncertainty and does not repeat a completed PUT', async () => {
  for (const registration of [() => new Response(signedUrl, { status: 500 }), () => Response.json({ unexpected: signedUrl })]) {
    const mock = transport({ registration });
    await assert.rejects(uploadFile(args, config, operations, mock), error => /foi enviado.*não confirmou/.test(error.message) && !error.message.includes('private-upload-signature'));
    assert.deepEqual(mock.calls.map(call => call.method), ['GET', 'PUT', 'POST']);
  }
});

test('caller cancellation before upload or after storage prevents the next stage', async () => {
  const before = new AbortController();
  before.abort(new Error(signedUrl));
  const unused = transport();
  await assert.rejects(uploadFile(args, config, operations, { ...unused, signal: before.signal }), /cancelado/);
  assert.equal(unused.calls.length, 0);

  const after = new AbortController();
  const mock = transport({ storage: () => { after.abort(new Error(signedUrl)); return new Response(''); } });
  await assert.rejects(uploadFile(args, config, operations, { ...mock, signal: after.signal }), error => /após o envio/.test(error.message) && !error.message.includes('private-upload-signature'));
  assert.deepEqual(mock.calls.map(call => call.method), ['GET', 'PUT']);
});
