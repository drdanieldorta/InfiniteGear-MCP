import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readConfig, saveConfig, getConfigPath } from './config.js';
import { testConnection } from './api-client.js';
import { loadCatalog } from './catalog.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
const assets = new Map([
  ['/', ['setup.html', 'text/html; charset=utf-8']],
  ['/setup.css', ['setup.css', 'text/css; charset=utf-8']],
  ['/setup.js', ['setup.js', 'text/javascript; charset=utf-8']],
]);

class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function validToken(provided, expected) {
  if (typeof provided !== 'string') return false;
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new InputError('Envie os dados no formato JSON.', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new InputError('Os dados enviados são grandes demais.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new InputError('Não foi possível ler os dados. Atualize os campos e tente novamente.');
  }
}

async function proposedConfig(input) {
  const existing = await readConfig();
  const next = { ...existing };
  for (const field of ['apiUrl', 'apiToken', 'partnerToken']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 8192)) {
      throw new InputError('Revise os campos de endereço e chave de acesso.');
    }
    const value = input[field]?.trim();
    if (value && /[\r\n]/.test(value)) throw new InputError('As chaves devem ocupar uma única linha.');
    // Empty secrets preserve saved values, as explained beside the input fields.
    if (field === 'apiUrl') next[field] = value ?? existing[field];
    else if (value) next[field] = value;
  }
  if (input.allowWrites !== undefined) {
    if (typeof input.allowWrites !== 'boolean') throw new InputError('Revise a opção de alterações.');
    next.allowWrites = input.allowWrites;
  }
  if (!next.apiUrl) throw new InputError('Informe o endereço da API da sua conta InfiniteGear.');
  let url;
  try { url = new URL(next.apiUrl); } catch { throw new InputError('O endereço da API precisa ser uma URL válida.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new InputError('Use o endereço HTTPS da API, sem usuário, senha, parâmetros ou fragmentos.');
  }
  if (url.hostname === 'readme.io' || url.hostname.endsWith('.readme.io')) {
    throw new InputError('Esse é o endereço da documentação. Informe o endereço da API da sua conta.');
  }
  if (!next.apiToken) throw new InputError('Informe a chave de acesso à API da sua conta.');
  return next;
}

function redact(message, config) {
  let safe = typeof message === 'string' ? message : 'Não foi possível concluir a verificação.';
  for (const secret of [config.apiToken, config.partnerToken, config.mcpToken]) {
    if (secret) safe = safe.split(secret).join('[chave protegida]');
  }
  return safe.slice(0, 1200);
}

async function catalogStatus() {
  try {
    const operations = await loadCatalog();
    return { apiCatalogReady: operations.length > 0, loadedOperations: operations.length };
  } catch {
    // A missing or unreadable API definition must not prevent preparing credentials.
    return { apiCatalogReady: false, loadedOperations: 0 };
  }
}

function launchBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  // No shell: the fragment and URL are passed as a single argument.
  const child = spawn(command, [url], { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
}

/** Start a local-only, session-authenticated visual configuration assistant. */
export async function startSetup({ host = '127.0.0.1', port = 17841, openBrowser = true } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('O assistente só pode abrir neste computador. Use 127.0.0.1 ou ::1.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Porta inválida para o assistente.');
  const bindHost = host === 'localhost' ? '127.0.0.1' : host;
  const setupToken = randomBytes(32).toString('hex');
  let allowedHosts;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const requestHost = request.headers.host;
    if (!allowedHosts?.has(requestHost)) return sendJson(response, 403, { error: 'Endereço local não autorizado.' });
    const expectedOrigin = `http://${requestHost}`;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== expectedOrigin) {
      return sendJson(response, 403, { error: 'Abra o assistente pelo endereço local mostrado no terminal.' });
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return sendJson(response, 403, { error: 'Solicitação de outro site bloqueada.' });
    }
    try {
      const route = new URL(request.url, expectedOrigin).pathname;
      if (assets.has(route) && request.method === 'GET') {
        const [filename, contentType] = assets.get(route);
        const content = await readFile(path.join(publicDirectory, filename));
        response.writeHead(200, { 'Content-Type': contentType });
        return response.end(content);
      }
      if (!route.startsWith('/api/')) return sendJson(response, 404, { error: 'Página não encontrada.' });
      if (!validToken(request.headers['x-setup-token'], setupToken)) {
        return sendJson(response, 401, { error: 'Sessão não encontrada. Abra novamente o endereço completo mostrado no terminal.' });
      }
      if (request.method !== 'GET' && origin !== expectedOrigin) {
        return sendJson(response, 403, { error: 'Origem da solicitação não autorizada.' });
      }
      if (route === '/api/status' && request.method === 'GET') {
        const config = await readConfig();
        return sendJson(response, 200, {
          configured: Boolean(config.apiUrl && config.apiToken),
          connectionVerified: false,
          ...await catalogStatus(),
          apiUrl: config.apiUrl || '',
          allowWrites: config.allowWrites === true,
          hasToken: Boolean(config.apiToken),
          hasPartnerToken: Boolean(config.partnerToken),
          configPath: getConfigPath(),
        });
      }
      if (route === '/api/client-config' && request.method === 'GET') {
        const stdio = { command: process.execPath, args: [cliPath, 'stdio', '--config', getConfigPath()] };
        return sendJson(response, 200, {
          claude: { mcpServers: { infinitegear: stdio } },
          cursor: { mcpServers: { infinitegear: stdio } },
          vscode: { servers: { infinitegear: { type: 'stdio', ...stdio } } },
          generic: { mcpServers: { infinitegear: stdio } },
        });
      }
      if (request.method === 'POST' && (route === '/api/test' || route === '/api/save')) {
        const config = await proposedConfig(await readJson(request));
        if (route === '/api/test') {
          const result = await testConnection(config);
          return sendJson(response, 200, { ok: result.ok === true, message: redact(result.message, config), ...await catalogStatus() });
        }
        await saveConfig(config);
        return sendJson(response, 200, {
          ok: true,
          message: 'Configuração salva neste computador. Salvar não verifica a conexão com a API.',
          configPath: getConfigPath(),
          connectionVerified: false,
          ...await catalogStatus(),
        });
      }
      return sendJson(response, 405, { error: 'Ação não disponível.' });
    } catch (error) {
      const status = error instanceof InputError ? error.status : 500;
      const message = error instanceof InputError ? error.message : 'Não foi possível concluir. Confira o endereço, a chave e a permissão de acesso ao arquivo de configuração.';
      if (!response.headersSent) sendJson(response, status, { error: message });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => {
      const actualPort = server.address().port;
      allowedHosts = new Set(bindHost === '::1' ? [`[::1]:${actualPort}`] : [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      server.removeListener('error', reject);
      resolve();
    });
  });
  const urlHost = bindHost === '::1' ? '[::1]' : bindHost;
  server.setupUrl = `http://${urlHost}:${server.address().port}/#token=${setupToken}`;
  server.configPath = getConfigPath();
  console.error(`\nInfiniteGear · configuração\nAbra neste computador: ${server.setupUrl}\nMantenha este terminal aberto durante a configuração.\n`);
  if (openBrowser) launchBrowser(server.setupUrl);
  return server;
}
