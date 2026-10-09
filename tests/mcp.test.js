import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from '../src/http-server.js';
import { operationsFromDocument } from '../src/catalog.js';
import { document, mockApi, mockConfig } from './fixture.js';

test('official SDK completes stdio initialize/list/call/resources/prompts against a simulated API', async t => {
  const api = await mockApi(); t.after(api.close);
  const temporary = await mkdtemp(join(tmpdir(), 'infinitegear-stdio-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const specPath = join(temporary, 'api.json');
  const configPath = join(temporary, 'config.json');
  await writeFile(specPath, JSON.stringify(document));
  await writeFile(configPath, JSON.stringify(mockConfig(api.url)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/cli.js'), 'stdio', '--config', configPath], env: { INFINITEGEAR_OPENAPI: specPath }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
  const client = new Client({ name: 'integration-test', version: '1.0.0' }); t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some(tool => tool.name === 'infinitegear_list_contacts'));
  assert(!tools.some(tool => tool.name === 'infinitegear_create_contact'));
  const result = await client.callTool({ name: 'infinitegear_list_contacts', arguments: { query: { pageSize: 1 } } });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).data.items[0].id, 'local-test-id');
  const invalid = await client.callTool({ name: 'infinitegear_get_contact', arguments: {} });
  assert.equal(invalid.isError, true);
  const discovery = await client.callTool({ name: 'infinitegear_buscar_documentacao', arguments: { busca: 'contatos' } });
  assert(JSON.parse(discovery.content[0].text).totalMatches > 0);
  const status = await client.readResource({ uri: 'infinitegear://status' });
  assert.equal(JSON.parse(status.contents[0].text).loadedOperations, 4);
  assert(!JSON.stringify(status).includes('test-account-secret'));
  assert.equal((await client.listPrompts()).prompts[0].name, 'comecar');
  assert((await client.getPrompt({ name: 'comecar' })).messages[0].content.text.includes('InfiniteGear'));
  assert(!stderr.includes('test-account-secret'));
});

test('HTTP rejects anonymous/cross-origin calls and SDK executes authorized MCP requests', async t => {
  const api = await mockApi(); t.after(api.close);
  const config = mockConfig(api.url);
  const server = await startHttp({ port: 0, config, operations: operationsFromDocument(document) });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok', apiCatalogReady: true });
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${config.mcpToken}`, Origin: 'https://unknown.invalid' } })).status, 403);
  const client = new Client({ name: 'http-test', version: '1.0.0' }); t.after(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${config.mcpToken}` } } });
  await client.connect(transport);
  assert((await client.listTools()).tools.length > 1);
  const result = await client.callTool({ name: 'infinitegear_list_contacts', arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).status, 200);
  assert.equal(api.calls.length, 1);
});

test('HTTP refuses missing or reused remote credentials', async () => {
  const config = mockConfig('https://example.invalid');
  await assert.rejects(startHttp({ config: { ...config, mcpToken: '' }, operations: [] }), /32 caracteres/);
  await assert.rejects(startHttp({ config: { ...config, apiToken: config.mcpToken }, operations: [] }), /exclusiva/);
});

test('empty catalog remains explicit and does not create guessed API tools', async t => {
  const server = await startHttp({ port: 0, config: mockConfig('https://example.invalid'), operations: [] });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal((await response.json()).apiCatalogReady, false);
});
