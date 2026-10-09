import { readFile, writeFile, rename, mkdir, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_API_URL = 'https://api.crm.infinitegear.app';
const defaults = { apiUrl: DEFAULT_API_URL, apiToken: '', partnerToken: '', allowWrites: false, mcpToken: '' };
const envFields = {
  apiUrl: 'INFINITEGEAR_API_URL', apiToken: 'INFINITEGEAR_API_TOKEN',
  partnerToken: 'INFINITEGEAR_PARTNER_TOKEN', mcpToken: 'INFINITEGEAR_MCP_TOKEN',
};

export function getConfigPath() {
  return resolve(process.env.INFINITEGEAR_CONFIG || join(homedir(), '.config', 'infinitegear-mcp', 'config.json'));
}

export function validateConfig(input, { requireCredentials = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A configuração deve ser um objeto.');
  const config = { ...defaults };
  for (const key of Object.keys(envFields)) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`Configuração inválida: ${key}.`);
    config[key] = (input[key] ?? defaults[key]).trim();
    if (/[\r\n\0]/.test(config[key])) throw new Error(`Configuração inválida: ${key}.`);
  }
  for (const key of ['apiToken', 'partnerToken']) config[key] = config[key].replace(/^Bearer\s+/i, '').trim();
  if (input.allowWrites !== undefined && typeof input.allowWrites !== 'boolean') throw new Error('A opção de permitir alterações deve ser verdadeira ou falsa.');
  config.allowWrites = input.allowWrites ?? false;
  if (config.apiUrl) {
    let url;
    try { url = new URL(config.apiUrl); } catch { throw new Error('Informe uma URL válida para a API.'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('A URL da API deve usar HTTPS. HTTP é permitido somente em testes locais.');
    if (url.username || url.password || url.search || url.hash) throw new Error('A URL da API não deve conter credenciais, parâmetros ou fragmentos.');
    if (url.hostname.endsWith('.readme.io') || url.hostname === 'readme.io') throw new Error('Esse é o site da documentação. Informe o endereço real da API da sua conta InfiniteGear.');
    config.apiUrl = url.href.replace(/\/+$/, '');
  }
  if (requireCredentials && !config.apiUrl) throw new Error('Configure a URL da API executando npm run setup.');
  if (requireCredentials && !config.apiToken) throw new Error('Configure o token da conta executando npm run setup.');
  return config;
}

export async function readConfig() {
  let saved = {};
  try { saved = JSON.parse(await readFile(getConfigPath(), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Não foi possível ler a configuração em ${getConfigPath()}. Verifique o arquivo JSON e suas permissões.`);
  }
  const merged = { ...saved };
  for (const [key, name] of Object.entries(envFields)) {
    if (process.env[name] !== undefined) merged[key] = process.env[name];
  }
  if (process.env.INFINITEGEAR_ALLOW_WRITES !== undefined) {
    const value = process.env.INFINITEGEAR_ALLOW_WRITES;
    if (!['true', 'false'].includes(value)) throw new Error('INFINITEGEAR_ALLOW_WRITES deve ser true ou false.');
    merged.allowWrites = value === 'true';
  }
  return validateConfig(merged);
}

export async function saveConfig(input) {
  const config = validateConfig(input, { requireCredentials: true });
  const file = getConfigPath();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    if (process.platform !== 'win32') await chmod(file, 0o600);
  } finally { await unlink(temporary).catch(() => {}); }
  return config;
}
