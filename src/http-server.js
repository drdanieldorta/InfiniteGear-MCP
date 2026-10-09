import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp-server.js';
import { readConfig } from './config.js';
import { loadCatalog } from './catalog.js';

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

function matchesToken(supplied, expected) {
  const actual = Buffer.from(supplied || '');
  const desired = Buffer.from(`Bearer ${expected}`);
  return actual.length === desired.length && timingSafeEqual(actual, desired);
}

export async function startHttp({ host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 3000), config, operations } = {}) {
  config ??= await readConfig();
  operations ??= await loadCatalog();
  if (!config.mcpToken || config.mcpToken.length < 32) throw new Error('Para iniciar o acesso remoto, defina INFINITEGEAR_MCP_TOKEN com pelo menos 32 caracteres. Esta senha é diferente do token do CRM.');
  if (config.mcpToken === config.apiToken || config.mcpToken === config.partnerToken) throw new Error('Use uma senha exclusiva para INFINITEGEAR_MCP_TOKEN, diferente das chaves da API.');
  const publicOrigin = process.env.INFINITEGEAR_PUBLIC_URL ? new URL(process.env.INFINITEGEAR_PUBLIC_URL).origin : null;
  const active = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/health' && request.method === 'GET') return sendJson(response, 200, { status: 'ok', apiCatalogReady: operations.length > 0 });
      if (request.url !== '/mcp') return sendJson(response, 404, { error: 'Rota não encontrada.' });
      const origin = request.headers.origin;
      const address = server.address();
      const localOrigins = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`, `http://[::1]:${address.port}`];
      if (origin && origin !== publicOrigin && !localOrigins.includes(origin)) return sendJson(response, 403, { error: 'Origem não autorizada.' });
      if (!matchesToken(request.headers.authorization, config.mcpToken)) return sendJson(response, 401, { error: 'Informe a senha de acesso ao MCP no cabeçalho Authorization: Bearer.' });
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return sendJson(response, 405, { error: 'Use POST para o transporte MCP sem sessão.' });
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) return sendJson(response, 415, { error: 'Use Content-Type: application/json.' });
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) return sendJson(response, 413, { error: 'A requisição excedeu 12 MiB. O upload aceita arquivos de até 8 MiB antes de codificar em base64.' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return sendJson(response, 400, { error: 'JSON inválido.' }); }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = await createMcpServer({ config, operations });
      active.add(mcp);
      response.once('close', () => { active.delete(mcp); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: 'O servidor não concluiu a requisição.' });
      else response.end();
    }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 15_000;
  server.on('close', () => { for (const mcp of active) void mcp.close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
