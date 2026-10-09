import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { validateConfig } from './config.js';
import { loadCatalog } from './catalog.js';
import { getDispatcher } from './network.js';
import { serializeQuery, encodePathValue, encodeHeaderValue, encodeBody } from './serialization.js';

const validators = new WeakMap();
const maxResponseBytes = 4 * 1024 * 1024;
const blockedHeaders = /^(authorization|proxy-authorization|host|connection|content-length|transfer-encoding|cookie|x-api-key)$/i;

export function redact(value, config = {}) {
  let result = String(value);
  for (const secret of [config.apiToken, config.partnerToken, config.mcpToken].filter(Boolean)) result = result.split(secret).join('[segredo oculto]');
  return result;
}

function responseDetails(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return ''; }
  if (!data || typeof data !== 'object') return '';
  const details = [];
  for (const key of ['title', 'detail', 'text', 'message']) {
    if (typeof data[key] === 'string') details.push(data[key]);
  }
  if (data.errors && typeof data.errors === 'object' && !Array.isArray(data.errors)) {
    for (const [field, messages] of Object.entries(data.errors).slice(0, 8)) {
      if (/token|secret|password|authorization|api.?key/i.test(field)) continue;
      const text = Array.isArray(messages) ? messages.filter(value => typeof value === 'string').join('; ') : typeof messages === 'string' ? messages : '';
      if (text) details.push(`${field}: ${text}`);
    }
  }
  const safe = details.join(' ').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [segredo oculto]').replace(/https?:\/\/\S+/g, '[URL omitida]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1200);
  return safe ? ` Detalhes da API: ${safe}` : '';
}

export function validateArguments(operation, args) {
  let validate = validators.get(operation);
  if (!validate) {
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
    addFormats(ajv);
    validate = ajv.compile(operation.schema);
    validators.set(operation, validate);
  }
  if (!validate(args)) {
    const issues = validate.errors.slice(0, 5).map(error => `${error.instancePath || 'argumentos'}: ${error.message}`).join('; ');
    throw new Error(`Revise os campos da operação: ${issues}`);
  }
}

async function limitedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new Error('A resposta excedeu 4 MB. Use os filtros ou a paginação da operação.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function executeOperation(operation, args, inputConfig, { fetchImpl = fetch, timeoutMs = 30_000, signal } = {}) {
  const config = validateConfig(inputConfig);
  if (!config.apiUrl) throw new Error('Configure a URL da API executando npm run setup.');
  validateArguments(operation, args);
  if (!operation.readOnly && !config.allowWrites) throw new Error('As alterações estão desativadas. Ative “Permitir alterações” no assistente de configuração para usar esta operação.');
  const credential = operation.auth === 'either' ? (args.credential || (config.apiToken ? 'account' : 'partner')) : operation.auth;
  const token = credential === 'partner' ? config.partnerToken : config.apiToken;
  if (!token && operation.authScheme?.type !== 'none') throw new Error(credential === 'partner' ? 'Esta operação exige um token de parceiro. Configure-o no assistente InfiniteGear.' : 'Configure o token da conta executando npm run setup.');
  let path = operation.path;
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path)) throw new Error('Caminho de operação inválido no catálogo.');
  for (const parameter of operation.parameters || []) {
    if (parameter.in === 'path') path = path.replaceAll(`{${parameter.name}}`, encodePathValue(parameter, args.path?.[parameter.name]));
  }
  if (/[{}]/.test(path) || path.split('/').some(segment => ['.', '..'].includes(segment))) throw new Error('Preencha todos os identificadores de caminho.');
  const url = new URL(`${config.apiUrl}${path}`);
  for (const parameter of operation.parameters || []) if (parameter.in === 'query') serializeQuery(url, parameter, args.query?.[parameter.name]);
  const headers = new Headers({ Accept: 'application/json' });
  for (const parameter of operation.parameters || []) {
    const value = args.headers?.[parameter.name];
    if (parameter.in === 'header' && value !== undefined) {
      if (blockedHeaders.test(parameter.name)) throw new Error('Esse cabeçalho é gerenciado pela conexão InfiniteGear.');
      headers.set(parameter.name, encodeHeaderValue(parameter, value));
    }
  }
  const cookies = (operation.parameters || []).filter(p => p.in === 'cookie' && args.cookies?.[p.name] !== undefined);
  if (cookies.length) headers.set('Cookie', cookies.map(parameter => {
    const value = args.cookies[parameter.name];
    if (value !== null && typeof value === 'object') throw new Error('Cookies com listas ou objetos ainda não são suportados por esta operação.');
    if (parameter.style && parameter.style !== 'form') throw new Error('O parâmetro de cookie exige um formato não suportado.');
    return `${encodeURIComponent(parameter.name)}=${encodeURIComponent(value === null ? '' : String(value))}`;
  }).join('; '));
  // Only the explicitly configured API origin receives credentials; redirects are never followed.
  const authentication = operation.authScheme || { type: 'bearer' };
  if (authentication.type === 'apiKey' && authentication.in === 'header') headers.set(authentication.name, token);
  else if (authentication.type === 'apiKey' && authentication.in === 'query') url.searchParams.set(authentication.name, token);
  else if (authentication.type === 'apiKey' && authentication.in === 'cookie') headers.set('Cookie', [headers.get('Cookie'), `${encodeURIComponent(authentication.name)}=${encodeURIComponent(token)}`].filter(Boolean).join('; '));
  else if (authentication.type === 'bearer') headers.set('Authorization', `Bearer ${token}`);
  else if (authentication.type !== 'none') throw new Error('A autenticação declarada por esta operação ainda não é suportada.');
  const body = encodeBody(operation, args, headers);
  let response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    response = await fetchImpl(url, { method: operation.method.toUpperCase(), headers, body, redirect: 'manual', dispatcher: getDispatcher(url), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('A API retornou um redirecionamento. Confira a URL da API; seu token não foi encaminhado.');
    }
    const raw = redact(await limitedBody(response), config);
    if (!response.ok) {
      const explanations = { 400: 'A API recusou os dados enviados.', 401: 'O token não foi aceito. Confira a chave da conta.', 403: 'O token não tem permissão para esta operação.', 404: 'O recurso não foi encontrado. Confira a URL, a versão e os identificadores.', 429: 'O limite de requisições foi atingido. Aguarde antes de tentar novamente.' };
      const retry = response.headers.get('retry-after');
      const suffix = response.status === 429 && retry && /^[\w,: -]{1,80}$/.test(retry) ? ` Tente novamente após: ${retry}.` : '';
      throw new Error(`${explanations[response.status] || 'A API não concluiu a requisição.'} HTTP ${response.status}.${suffix}${responseDetails(raw)}`);
    }
    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
    return { status: response.status, data };
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('A requisição foi interrompida ou excedeu o tempo limite. Confira o resultado antes de repetir uma alteração.');
    if (error instanceof TypeError) throw new Error('Não foi possível conectar à API. Confira a URL, a conexão e os certificados HTTPS.');
    throw new Error(redact(error.message, config));
  }
}

export async function testConnection(config, { credential = 'account' } = {}) {
  try {
    config = validateConfig(config);
    if (!config.apiUrl) throw new Error('Configure a URL da API InfiniteGear.');
    if (credential === 'partner' ? !config.partnerToken : !config.apiToken) throw new Error(credential === 'partner' ? 'Configure o token de parceiro para validar o acesso administrativo.' : 'Configure o token da conta para validar a conexão.');
    const operations = await loadCatalog();
    const candidates = operations.filter(op => op.method === 'GET' && op.readOnly && (credential === 'partner' ? op.auth === 'partner' : op.auth === 'account') && !op.parameters.some(p => p.required) && !op.requestBody?.required);
    const operation = candidates.find(op => op.path === (credential === 'partner' ? '/core/v1/company' : '/core/v1/contact')) || candidates[0];
    if (!operation) return { ok: false, message: 'Falta uma especificação OpenAPI com uma operação de consulta. A configuração pode ser salva, mas a conexão ainda não foi validada. Consulte o guia de configuração da API.' };
    const query = {};
    for (const parameter of operation.parameters) if (parameter.in === 'query' && /^page.?size$|^limit$/i.test(parameter.name)) query[parameter.name] = Math.max(1, parameter.schema?.minimum || 1);
    await executeOperation(operation, Object.keys(query).length ? { query } : {}, { ...config, allowWrites: false });
    return { ok: true, message: `Conexão ${credential === 'partner' ? 'de parceiro' : 'da conta'} confirmada: a API respondeu a uma consulta sem alterar seus dados.` };
  } catch (error) { return { ok: false, message: redact(error.message, config) }; }
}
