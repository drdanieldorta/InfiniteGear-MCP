#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-server.js';
import { readConfig, getConfigPath } from './config.js';
import { loadCatalog } from './catalog.js';
import { testConnection } from './api-client.js';

async function main() {
  const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, port: { type: 'string' }, partner: { type: 'boolean' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  if (values.config) process.env.INFINITEGEAR_CONFIG = values.config;
  const command = positionals[0] || 'stdio';
  if (values.help) {
    console.log('InfiniteGear MCP\n\n  setup       Abrir assistente de configuração local\n  stdio       Conectar um aplicativo MCP (padrão)\n  http        Iniciar acesso remoto autenticado\n  doctor      Conferir catálogo, configuração e conexão\n\nOpções: --config CAMINHO, --port NÚMERO, --no-open (setup), --partner (doctor: testar token de parceiro).');
    return;
  }
  if (values.port !== undefined && (!/^\d+$/.test(values.port) || Number(values.port) > 65535)) throw new Error('Informe uma porta válida entre 0 e 65535.');
  if (command === 'stdio') {
    const server = await createMcpServer();
    await server.connect(new StdioServerTransport());
    return;
  }
  if (command === 'setup') {
    const { startSetup } = await import('./setup.js');
    await startSetup({ ...(values.port === undefined ? {} : { port: Number(values.port) }), openBrowser: !values['no-open'] });
    return;
  }
  if (command === 'http') {
    const { startHttp } = await import('./http-server.js');
    const server = await startHttp(values.port === undefined ? {} : { port: Number(values.port) });
    console.error(`InfiniteGear MCP iniciado na porta ${server.address().port}. Use /mcp com sua senha de acesso. O endpoint /health confirma o processo; use doctor para validar a API.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
    return;
  }
  if (command === 'doctor') {
    const config = await readConfig();
    const operations = await loadCatalog();
    console.log(`InfiniteGear MCP\nNode: ${process.version}\nConfiguração: ${getConfigPath()}\nOperações carregadas: ${operations.length}\nToken da conta: ${config.apiToken ? 'configurado' : 'ausente'}\nToken de parceiro: ${config.partnerToken ? 'configurado' : 'não configurado (opcional)'}\nAlterações: ${config.allowWrites ? 'permitidas' : 'desativadas'}`);
    const result = await testConnection(config, { credential: values.partner ? 'partner' : 'account' });
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error('Comando desconhecido. Use --help para ver as opções.');
}

main().catch(error => { console.error(`InfiniteGear: ${error.message}`); process.exitCode = 1; });
