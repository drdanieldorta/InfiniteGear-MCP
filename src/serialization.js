import { randomBytes } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const validators = new WeakMap();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const mimeType = value => String(value).split(';', 1)[0].trim().toLowerCase();
const isJson = value => mimeType(value) === 'application/json' || mimeType(value).endsWith('+json');

function primitive(value) {
  if (value === null) return '';
  if (!['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error('Esse parâmetro aceita apenas valores simples; objetos aninhados exigem um formato JSON declarado.');
  }
  return String(value);
}

function pairs(value) {
  return Object.entries(value).map(([key, member]) => [key, primitive(member)]);
}

function contentValue(parameter, value) {
  if (!parameter.content) return undefined;
  const types = Object.keys(parameter.content);
  if (types.length !== 1) throw new Error('Um parâmetro deve declarar exatamente um tipo de conteúdo.');
  if (isJson(types[0])) return JSON.stringify(value);
  if (mimeType(types[0]).startsWith('text/') && typeof value === 'string') return value;
  throw new Error(`Conteúdo de parâmetro não suportado: ${types[0]}.`);
}

function queryAppend(url, parameter, name, value) {
  const text = primitive(value);
  // Preserving these characters can change the meaning of the query itself.
  // Require the usual percent encoding until a spec provides an unambiguous alternative.
  if (parameter.allowReserved && /[:/?#[\]@!$&'()*+,;=]/.test(text)) {
    throw new Error('allowReserved com caracteres reservados não é suportado. Use uma especificação que permita a codificação normal da URL.');
  }
  url.searchParams.append(name, text);
}

/** Serialize the documented OpenAPI query styles without flattening nested values. */
export function serializeQuery(url, parameter, value) {
  if (value === undefined) return;
  const content = contentValue(parameter, value);
  if (content !== undefined) { queryAppend(url, parameter, parameter.name, content); return; }
  const { name } = parameter;
  const style = parameter.style || 'form';
  const explode = parameter.explode ?? style === 'form';
  if (style === 'deepObject') {
    if (!isObject(value) || parameter.explode === false) throw new Error('deepObject exige um objeto simples e explode habilitado.');
    for (const [key, member] of pairs(value)) queryAppend(url, parameter, `${name}[${key}]`, member);
    return;
  }
  if (!['form', 'spaceDelimited', 'pipeDelimited'].includes(style)) throw new Error(`Formato de parâmetro não suportado: ${style}.`);
  if (style !== 'form' && (!Array.isArray(value) || explode)) {
    throw new Error(`${style} exige uma lista simples com explode desabilitado.`);
  }
  if (Array.isArray(value)) {
    const values = value.map(primitive);
    if (explode) for (const member of values) queryAppend(url, parameter, name, member);
    else queryAppend(url, parameter, name, values.join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','));
  } else if (isObject(value)) {
    const entries = pairs(value);
    if (explode) for (const [key, member] of entries) queryAppend(url, parameter, key, member);
    else queryAppend(url, parameter, name, entries.flat().join(','));
  } else queryAppend(url, parameter, name, value);
}

/** Encode one complete path-parameter expansion, including label/matrix punctuation. */
export function encodePathValue(parameter, value) {
  if (value === undefined || value === null) throw new Error(`Preencha o identificador ${parameter.name}.`);
  const content = contentValue(parameter, value);
  if (content !== undefined) value = content;
  const encode = member => encodeURIComponent(primitive(member)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const style = parameter.style || 'simple';
  const explode = parameter.explode ?? false;
  if (!['simple', 'label', 'matrix'].includes(style)) throw new Error(`Formato de caminho não suportado: ${style}.`);
  let result;
  if (Array.isArray(value)) {
    const items = value.map(encode);
    if (style === 'matrix') result = explode ? items.map(item => `;${encode(parameter.name)}=${item}`).join('') : `;${encode(parameter.name)}=${items.join(',')}`;
    else if (style === 'label') result = `.${items.join(explode ? '.' : ',')}`;
    else result = items.join(',');
  } else if (isObject(value)) {
    const entries = pairs(value).map(([key, member]) => [encode(key), encode(member)]);
    if (style === 'matrix') result = explode ? entries.map(([key, member]) => `;${key}=${member}`).join('') : `;${encode(parameter.name)}=${entries.flat().join(',')}`;
    else if (style === 'label') result = `.${explode ? entries.map(([key, member]) => `${key}=${member}`).join('.') : entries.flat().join(',')}`;
    else result = explode ? entries.map(([key, member]) => `${key}=${member}`).join(',') : entries.flat().join(',');
  } else {
    const text = encode(value);
    result = style === 'label' ? `.${text}` : style === 'matrix' ? `;${encode(parameter.name)}=${text}` : text;
  }
  if (result === '.' || result === '..') throw new Error('Identificador de caminho inválido.');
  return result;
}

/** Header parameters use OpenAPI simple serialization, not JavaScript object coercion. */
export function encodeHeaderValue(parameter, value) {
  let result = contentValue(parameter, value);
  if (result === undefined) {
    if (parameter.style && parameter.style !== 'simple') throw new Error(`Formato de cabeçalho não suportado: ${parameter.style}.`);
    if (Array.isArray(value)) result = value.map(primitive).join(',');
    else if (isObject(value)) result = parameter.explode ? pairs(value).map(([key, member]) => `${key}=${member}`).join(',') : pairs(value).flat().join(',');
    else result = primitive(value);
  }
  if (/[\r\n\0]/.test(result)) throw new Error('Cabeçalhos não podem conter quebras de linha.');
  return result;
}

function compile(schema) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  for (const format of ['binary', 'byte', 'int32', 'int64', 'float', 'double', 'password']) ajv.addFormat(format, true);
  return ajv.compile(schema);
}

function validateBody(schema, body) {
  let validate = schema && typeof schema === 'object' ? validators.get(schema) : undefined;
  if (!validate) {
    validate = compile(schema);
    if (schema && typeof schema === 'object') validators.set(schema, validate);
  }
  if (!validate(body)) {
    const issues = validate.errors.slice(0, 5).map(error => `${error.instancePath || 'corpo'}: ${error.message}`).join('; ');
    throw new Error(`O corpo não corresponde ao tipo de conteúdo selecionado: ${issues}`);
  }
}

function reference(root, pointer) {
  if (!pointer.startsWith('#/')) throw new Error('A codificação do corpo aceita apenas referências internas de schema.');
  let value = root;
  for (const token of pointer.slice(2).split('/')) {
    const key = decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || !Object.hasOwn(value, key)) throw new Error(`Referência de schema inexistente: ${pointer}`);
    value = value[key];
  }
  return value;
}

function mergeSchemas(left, right) {
  if (left === false || right === false) return false;
  if (left === true) return right;
  if (right === true) return left;
  const merged = { ...left, ...right };
  for (const keyword of ['contentEncoding', 'contentMediaType', 'format']) {
    if (left[keyword] !== undefined && right[keyword] !== undefined && left[keyword] !== right[keyword]) {
      throw new Error('O schema declara codificações conflitantes para o mesmo campo.');
    }
  }
  if (left.properties || right.properties) {
    merged.properties = { ...left.properties };
    for (const [key, value] of Object.entries(right.properties || {})) {
      Object.defineProperty(merged.properties, key, { value: Object.hasOwn(merged.properties, key) ? { allOf: [merged.properties[key], value] } : value, enumerable: true, configurable: true, writable: true });
    }
  }
  if (left.items !== undefined && right.items !== undefined) merged.items = { allOf: [left.items, right.items] };
  return merged;
}

function schemaForValue(schema, value, root, visited = new Set()) {
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object') return {};
  if (['if', 'then', 'else', 'dependentSchemas', 'patternProperties'].some(keyword => schema[keyword] !== undefined)) {
    throw new Error('Schemas condicionais ou propriedades por padrão precisam de uma codificação explícita antes de enviar um formulário.');
  }
  if (schema.contentEncoding && schema.contentEncoding !== 'base64') {
    throw new Error(`Codificação de conteúdo não suportada: ${schema.contentEncoding}.`);
  }
  const { $ref, allOf, anyOf, oneOf, ...base } = schema;
  let resolved = base;
  if ($ref) {
    if (visited.has($ref)) throw new Error('Referência circular sem estrutura suficiente para codificar o corpo.');
    const next = new Set(visited).add($ref);
    resolved = mergeSchemas(schemaForValue(reference(root, $ref), value, root, next), base);
  }
  if (allOf) for (const member of allOf) resolved = mergeSchemas(resolved, schemaForValue(member, value, root, new Set(visited)));
  for (const choices of [anyOf, oneOf].filter(Boolean)) {
    const matches = choices.filter(choice => compile(typeof choice === 'boolean' ? choice : { $defs: root.$defs, ...choice })(value));
    if (matches.length !== 1) throw new Error('O schema oferece codificações ambíguas para o corpo. Selecione uma estrutura sem alternativas sobrepostas.');
    resolved = mergeSchemas(resolved, schemaForValue(matches[0], value, root, new Set(visited)));
  }
  return resolved;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Envie o conteúdo binário codificado em base64.');
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) throw new Error('O conteúdo binário não usa uma codificação base64 válida.');
  return buffer;
}

const isBinary = schema => schema && (schema.contentEncoding === 'base64' || ['binary', 'byte'].includes(schema.format));

function multipartBody(body, media, headers) {
  if (!isObject(body)) throw new Error('multipart/form-data exige um objeto com os campos do formulário.');
  const root = media.schema ?? {};
  const schema = schemaForValue(root, body, root);
  const parts = [];
  const quote = value => {
    if (/[\r\n\0]/.test(value)) throw new Error('Nomes de campos multipart não podem conter quebras de linha.');
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  };
  for (const [name, value] of Object.entries(body)) {
    const encoding = media.encoding?.[name] || {};
    if (encoding.style !== undefined || encoding.explode !== undefined || encoding.allowReserved !== undefined) {
      throw new Error('Opções style/explode/allowReserved em multipart não são suportadas; use o formato padrão de partes repetidas.');
    }
    if (Object.keys(encoding.headers || {}).some(header => header.toLowerCase() !== 'content-type')) {
      throw new Error('Cabeçalhos personalizados em uma parte multipart ainda não são suportados.');
    }
    const property = schemaForValue(schema.properties?.[name] ?? (isObject(schema.additionalProperties) ? schema.additionalProperties : {}), value, root);
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const itemSchema = Array.isArray(value) ? schemaForValue(property.items ?? {}, item, root) : property;
      const binary = isBinary(itemSchema);
      const type = encoding.contentType || itemSchema.contentMediaType || (binary ? 'application/octet-stream' : item !== null && typeof item === 'object' ? 'application/json' : 'text/plain; charset=utf-8');
      if (/[\r\n\0,]/.test(type)) throw new Error('Informe um único tipo de conteúdo válido para cada parte multipart.');
      let bytes;
      if (binary) bytes = decodeBase64(item);
      else if (isJson(type)) bytes = Buffer.from(JSON.stringify(item));
      else if (item !== null && typeof item === 'object') throw new Error('Objetos em multipart precisam de um tipo de conteúdo JSON.');
      else bytes = Buffer.from(primitive(item));
      const disposition = `Content-Disposition: form-data; name="${quote(name)}"${binary ? `; filename="${quote(name)}"` : ''}`;
      parts.push({ header: `${disposition}\r\nContent-Type: ${type}\r\n\r\n`, bytes });
    }
  }
  let boundary;
  do { boundary = `infinitegear-${randomBytes(18).toString('hex')}`; }
  while (parts.some(part => part.bytes.includes(boundary)));
  headers.set('Content-Type', `multipart/form-data; boundary=${boundary}`);
  return Buffer.concat([
    ...parts.flatMap(part => [Buffer.from(`--${boundary}\r\n${part.header}`), part.bytes, Buffer.from('\r\n')]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

/** Validate and encode the actual selected media type, independently of the tool's union schema. */
export function encodeBody(operation, args, headers) {
  if (args.body === undefined) {
    if (operation.requestBody?.required) throw new Error('Preencha o corpo obrigatório desta operação.');
    return undefined;
  }
  const content = operation.requestBody?.content || {};
  const types = Object.keys(content);
  const type = args.contentType || types.find(candidate => mimeType(candidate) === 'application/json') || types.find(isJson) || types[0];
  if (!type || !Object.hasOwn(content, type)) throw new Error('O formato do corpo não está declarado nesta operação.');
  if (/[\r\n\0]/.test(type)) throw new Error('Tipo de conteúdo inválido.');
  const media = content[type];
  validateBody(media.schema ?? {}, args.body);
  const normalized = mimeType(type);
  if (isJson(type)) { headers.set('Content-Type', type); return JSON.stringify(args.body); }
  if (normalized === 'application/x-www-form-urlencoded') {
    if (!isObject(args.body)) throw new Error('application/x-www-form-urlencoded exige um objeto.');
    const encoded = new URL('https://local.invalid');
    for (const [name, value] of Object.entries(args.body)) serializeQuery(encoded, { name, ...media.encoding?.[name] }, value);
    headers.set('Content-Type', type);
    return encoded.searchParams;
  }
  if (normalized === 'multipart/form-data') return multipartBody(args.body, media, headers);
  if (normalized.startsWith('text/')) {
    if (typeof args.body !== 'string') throw new Error('Um corpo de texto precisa ser uma string.');
    headers.set('Content-Type', type);
    return args.body;
  }
  const root = media.schema ?? {};
  const schema = schemaForValue(root, args.body, root);
  if (normalized === 'application/octet-stream' || isBinary(schema)) {
    headers.set('Content-Type', type);
    return decodeBase64(args.body);
  }
  throw new Error(`Formato de envio ainda não suportado: ${type}.`);
}
