import { executeOperation, validateArguments } from './api-client.js';
import { validateConfig } from './config.js';
import { getDispatcher } from './network.js';

// This is a local MCP limit, not a limit asserted by the InfiniteGear API.
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const maximumEncodedLength = Math.ceil(UPLOAD_MAX_BYTES / 3) * 4;
const storageOrigin = 'https://wts-storage.s3.sa-east-1.amazonaws.com';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fileTypes = ['UNDEFINED', 'PDF', 'EXCEL', 'WORD', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'];

export const UPLOAD_TOOL = {
  name: 'infinitegear_upload_arquivo',
  title: 'Enviar arquivo para InfiniteGear',
  description: 'Envia um arquivo fornecido em base64 e registra seu ID reutilizável nas mensagens. Requer permitir alterações. O cliente deve fornecer os bytes; esta ferramenta não lê caminhos de arquivos. Limite local: 8 MiB por arquivo, independente dos limites da API. Não repete envios automaticamente.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\u0000-\\u001f\\u007f]+$', description: 'Nome do arquivo com extensão, sem caminho. Ex.: contrato.pdf.' },
      contentBase64: { type: 'string', minLength: 4, maxLength: maximumEncodedLength, pattern: '^[A-Za-z0-9+/]*={0,2}$', description: 'Bytes do arquivo em base64 padrão, com padding quando necessário, sem prefixo data: e sem espaços. Máximo local: 8 MiB após decodificar.' },
      type: { type: 'string', enum: fileTypes, default: 'UNDEFINED', description: 'Tipo documentado do arquivo. UNDEFINED permite à API identificar o tipo.' },
      mimeType: { type: 'string', minLength: 3, maxLength: 255, pattern: '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$', description: 'MIME do arquivo, por exemplo application/pdf. Quando informado, é usado também no Content-Type do upload.' },
    },
    required: ['name', 'contentBase64'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

const uploadArguments = { schema: UPLOAD_TOOL.inputSchema };

function operationFor(operations, method) {
  const matches = operations.filter(operation => operation.path === '/core/v2/file' && operation.method.toUpperCase() === method);
  if (matches.length !== 1) throw new Error('O catálogo precisa conter as operações GET e POST /core/v2/file para enviar arquivos.');
  return matches[0];
}

function checkedUploadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A API retornou um endereço de upload inválido.'); }
  if (url.origin !== storageOrigin || url.username || url.password || url.hash) {
    throw new Error('A API retornou um destino de upload não autorizado. Confira o contrato e o domínio de armazenamento da sua conta.');
  }
  return url;
}

function checkCancellation(signal, afterUpload = false) {
  if (signal?.aborted) throw new Error(afterUpload
    ? 'O upload foi interrompido após o envio. Confira se o arquivo foi registrado antes de repetir a operação.'
    : 'O upload foi cancelado antes do envio do arquivo.');
}

export async function uploadFile(args, inputConfig, operations, { fetchImpl = fetch, signal } = {}) {
  const config = validateConfig(inputConfig, { requireCredentials: true });
  if (!config.allowWrites) throw new Error('As alterações estão desativadas. Ative “Permitir alterações” no assistente de configuração para enviar arquivos.');
  validateArguments(uploadArguments, args);
  if (!args.name.trim() || ['.', '..'].includes(args.name)) throw new Error('Informe um nome de arquivo, sem caminho.');
  if (args.contentBase64.length % 4 !== 0) throw new Error('O conteúdo deve usar base64 padrão completo, sem espaços ou prefixos.');
  const bytes = Buffer.from(args.contentBase64, 'base64');
  if (bytes.toString('base64') !== args.contentBase64) throw new Error('O conteúdo deve usar base64 padrão canônico, sem espaços ou prefixos.');
  if (bytes.length > UPLOAD_MAX_BYTES) throw new Error('O arquivo excedeu o limite local de 8 MiB por upload do MCP.');
  const getFile = operationFor(operations, 'GET');
  const saveFile = operationFor(operations, 'POST');
  const query = { Type: args.type ?? 'UNDEFINED', Name: args.name };
  if (args.mimeType !== undefined) query.MimeType = args.mimeType;
  checkCancellation(signal);

  let temporary;
  try {
    temporary = (await executeOperation(getFile, { query }, config, { fetchImpl, signal })).data;
  } catch {
    // Do not relay remote errors: they can contain signed URLs or other secrets.
    throw new Error('Não foi possível preparar o upload na API. Confira o token, a conexão e o catálogo de arquivos. Nenhum arquivo foi enviado.');
  }
  if (!temporary || typeof temporary !== 'object' || !uuid.test(temporary.tempFileId) || typeof temporary.urlUpload !== 'string') {
    throw new Error('A API não retornou um identificador temporário e um endereço válidos para o upload.');
  }
  const uploadUrl = checkedUploadUrl(temporary.urlUpload);
  checkCancellation(signal);

  try {
    const timeout = AbortSignal.timeout(30_000);
    const headers = new Headers();
    // The API docs do not prescribe custom storage headers. Match the MIME, if
    // explicitly supplied, and never forward CRM, partner or MCP credentials.
    if (args.mimeType !== undefined) headers.set('Content-Type', args.mimeType);
    const response = await fetchImpl(uploadUrl, {
      method: 'PUT', body: bytes, headers, redirect: 'manual',
      dispatcher: getDispatcher(uploadUrl),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    // Storage responses can echo a signed URL; discard them without parsing,
    // returning or logging their contents, including on redirects and errors.
    await response.body?.cancel();
    if (!response.ok || response.redirected) throw new Error('Storage rejected the upload.');
  } catch {
    throw new Error('O armazenamento não confirmou o upload. O arquivo não foi registrado pelo MCP. Confira o resultado antes de repetir; o envio não foi repetido automaticamente.');
  }

  checkCancellation(signal, true);
  try {
    const result = await executeOperation(saveFile, { body: { tempFileId: temporary.tempFileId } }, config, { fetchImpl, signal });
    if (!result.data || typeof result.data !== 'object' || !uuid.test(result.data.id)) throw new Error('Invalid registration response.');
    return result.data;
  } catch {
    throw new Error('O arquivo foi enviado, mas a API não confirmou seu registro. Confira o resultado antes de repetir; o envio não foi repetido automaticamente.');
  }
}
