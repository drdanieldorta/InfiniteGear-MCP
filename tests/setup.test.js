import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { request } from 'node:http';
import { startSetup } from '../src/setup.js';

test('visual setup accepts only loopback listeners', async () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
    await assert.rejects(startSetup({ host, port: 0, openBrowser: false }), /só pode abrir neste computador/);
  }
});

test('local setup protects configuration and does not disclose saved secrets', async (suite) => {
  const directory = await mkdtemp(join(tmpdir(), 'infinitegear-setup-'));
  const names = ['INFINITEGEAR_CONFIG', 'INFINITEGEAR_API_URL', 'INFINITEGEAR_API_TOKEN', 'INFINITEGEAR_PARTNER_TOKEN', 'INFINITEGEAR_ALLOW_WRITES', 'INFINITEGEAR_MCP_TOKEN', 'INFINITEGEAR_OPENAPI'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.INFINITEGEAR_CONFIG = join(directory, 'config.json');
  process.env.INFINITEGEAR_OPENAPI = join(directory, 'api-definition');
  await mkdir(process.env.INFINITEGEAR_OPENAPI);
  const server = await startSetup({ port: 0, openBrowser: false });
  const setupUrl = new URL(server.setupUrl);
  const base = setupUrl.origin;
  const token = new URLSearchParams(setupUrl.hash.slice(1)).get('token');
  const secret = 'fake-account-key-for-setup-tests';
  const partnerSecret = 'fake-partner-key-for-setup-tests';
  const headers = { 'X-Setup-Token': token, Origin: base, 'Content-Type': 'application/json' };
  const post = (route, input, extra = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(input),
  });

  suite.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  await suite.test('the session credential uses a URL fragment and is absent from public assets', async () => {
    assert.equal(setupUrl.search, '');
    assert.equal(token.length, 64);
    for (const route of ['/', '/setup.css', '/setup.js']) {
      const result = await fetch(`${base}${route}`);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(result.headers.get('access-control-allow-origin'), null);
      assert.ok(result.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
      assert.ok(!(await result.text()).includes(token));
    }
  });

  await suite.test('read endpoints require the session token', async () => {
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/client-config`, { headers: { 'X-Setup-Token': 'invalid' } })).status, 401);
    const result = await fetch(`${base}/api/status`, { headers });
    assert.equal(result.status, 200);
    const status = await result.json();
    assert.equal(status.configured, false);
    assert.equal(status.hasToken, false);
    assert.equal(status.allowWrites, false);
    assert.equal(status.apiCatalogReady, false);
    assert.equal(status.loadedOperations, 0);
    assert.equal(status.connectionVerified, false);
  });

  await suite.test('rejects DNS rebinding and cross-origin requests even with a valid token', async () => {
    const reboundStatus = await new Promise((resolve, reject) => {
      const incoming = request(`${base}/`, { headers: { Host: 'attacker.invalid' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      incoming.on('error', reject);
      incoming.end();
    });
    assert.equal(reboundStatus, 403);
    assert.equal((await fetch(`${base}/api/status`, { headers: { ...headers, Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await post('/api/save', {}, { Origin: 'null' })).status, 403);
    assert.equal((await post('/api/save', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const noOrigin = await fetch(`${base}/api/save`, { method: 'POST', headers: { 'X-Setup-Token': token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noOrigin.status, 403);
    const noToken = await fetch(`${base}/api/save`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noToken.status, 401);
    const form = await fetch(`${base}/api/save`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '{}' });
    assert.equal(form.status, 415);
  });

  await suite.test('validates API addresses before testing or saving', async () => {
    for (const apiUrl of ['https://infinitegear.readme.io/', 'http://api.example.invalid/', 'https://user:password@api.example.invalid/', 'not a URL']) {
      const result = await post('/api/test', { apiUrl, apiToken: secret });
      assert.equal(result.status, 400);
      assert.ok(!(await result.text()).includes(secret));
    }
    const oversized = await post('/api/save', { apiUrl: 'https://api.example.invalid', apiToken: 'a'.repeat(20_000) });
    assert.equal(oversized.status, 413);
    assert.equal((await post('/api/save', { apiUrl: 'https://api.example.invalid', apiToken: secret, allowWrites: 'true' })).status, 400);
  });

  await suite.test('saves a protected configuration and preserves empty existing secrets', async () => {
    const result = await post('/api/save', { apiUrl: 'https://api.example.invalid/', apiToken: secret, partnerToken: partnerSecret, allowWrites: false });
    assert.equal(result.status, 200);
    const savedResponse = await result.text();
    assert.ok(!savedResponse.includes(secret));
    const savedStatus = JSON.parse(savedResponse);
    assert.equal(savedStatus.connectionVerified, false);
    assert.equal(savedStatus.apiCatalogReady, false);
    assert.equal(savedStatus.loadedOperations, 0);
    const updated = await post('/api/save', { apiUrl: 'https://api.example.invalid/v1', apiToken: '', partnerToken: '', allowWrites: true });
    assert.equal(updated.status, 200);
    const saved = JSON.parse(await readFile(process.env.INFINITEGEAR_CONFIG, 'utf8'));
    assert.equal(saved.apiToken, secret);
    assert.equal(saved.partnerToken, partnerSecret);
    assert.equal(saved.allowWrites, true);
    assert.equal(saved.apiUrl, 'https://api.example.invalid/v1');
  });

  await suite.test('status returns only secret presence and client snippets use absolute paths', async () => {
    const statusResponse = await fetch(`${base}/api/status`, { headers });
    const statusText = await statusResponse.text();
    assert.ok(!statusText.includes(secret));
    assert.ok(!statusText.includes(partnerSecret));
    const status = JSON.parse(statusText);
    assert.equal(status.hasToken, true);
    assert.equal(status.hasPartnerToken, true);
    assert.equal(status.configured, true);
    assert.equal(status.connectionVerified, false);
    assert.equal(status.apiCatalogReady, false);
    assert.equal(status.loadedOperations, 0);
    assert.equal(status.apiToken, undefined);
    assert.equal(status.partnerToken, undefined);
    const clientResponse = await fetch(`${base}/api/client-config`, { headers });
    const snippets = await clientResponse.text();
    assert.ok(!snippets.includes(secret));
    assert.ok(!snippets.includes(partnerSecret));
    const client = JSON.parse(snippets);
    const stdio = client.claude.mcpServers.infinitegear;
    assert.equal(stdio.command, process.execPath);
    assert.ok(isAbsolute(stdio.args[0]));
    assert.equal(stdio.args[1], 'stdio');
    assert.equal(stdio.args[2], '--config');
    assert.equal(stdio.args[3], process.env.INFINITEGEAR_CONFIG);
    assert.equal(client.vscode.servers.infinitegear.type, 'stdio');
  });

  await suite.test('an empty API definition cannot be mistaken for a verified connection', async () => {
    const result = await post('/api/test', { apiUrl: 'https://api.example.invalid', apiToken: secret });
    assert.equal(result.status, 200);
    const status = await result.json();
    assert.equal(status.ok, false);
    assert.equal(status.apiCatalogReady, false);
    assert.equal(status.loadedOperations, 0);
    assert.match(status.message, /OpenAPI|catálogo|definição/i);
    const afterTest = await (await fetch(`${base}/api/status`, { headers })).json();
    assert.equal(afterTest.configured, true);
    assert.equal(afterTest.connectionVerified, false);
  });
});
