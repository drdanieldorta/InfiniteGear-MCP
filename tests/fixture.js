import http from 'node:http';

// Synthetic contract: it verifies the adapter, not availability of a real CRM route.
export const document = {
  openapi: '3.0.3', info: { title: 'Contrato de teste InfiniteGear', version: '1.0.0' },
  servers: [{ url: 'https://example.invalid/core' }],
  components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } }, schemas: {
    Contact: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
  } },
  security: [{ token: [] }],
  paths: {
    '/v1/contact': {
      get: { operationId: 'list_contacts', parameters: [{ in: 'query', name: 'pageSize', schema: { type: 'integer', minimum: 1 } }, { in: 'query', name: 'tags', schema: { type: 'array', items: { type: 'string' } } }], responses: { 200: { description: 'OK' } } },
      post: { operationId: 'create_contact', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Contact' } } } }, responses: { 201: { description: 'Created' } } },
    },
    '/v1/contact/{id}': {
      get: { operationId: 'get_contact', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } },
    },
    '/v1/company': { get: { operationId: 'list_accounts', responses: { 200: { description: 'OK' } } } },
  },
};

export async function mockApi(handler) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    calls.push({ method: request.method, url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : null });
    if (handler) return handler(request, response, calls.at(-1));
    response.writeHead(request.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ items: [{ id: 'local-test-id', name: 'Contato de teste' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export function mockConfig(apiUrl) {
  return { apiUrl, apiToken: 'test-account-secret', partnerToken: 'test-partner-secret', allowWrites: false, mcpToken: 'test-mcp-secret-independent-0123456789' };
}
