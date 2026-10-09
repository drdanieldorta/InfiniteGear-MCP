import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';

const BUNDLED_DIRECTORY = fileURLToPath(new URL('../data/openapi/', import.meta.url));
const DOCS_URL = 'https://infinitegear.readme.io/llms.txt';
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const PARAMETER_GROUPS = { path: 'path', query: 'query', header: 'headers', cookie: 'cookies' };
const ANNOTATIONS = new Set([
  'description', 'summary', 'title', 'externalDocs', 'example', 'examples', '$comment',
  'contact', 'license', 'termsOfService', 'tags',
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pointer(document, reference) {
  if (!reference.startsWith('#/')) {
    throw new Error('A especificação contém uma referência externa. Importe primeiro os arquivos locais.');
  }
  let value = document;
  for (const token of reference.slice(2).split('/')) {
    const key = decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || !Object.hasOwn(value, key)) throw new Error(`Referência interna inexistente: ${reference}`);
    value = value[key];
  }
  return value;
}

function dereferenceObject(document, object, visited = new Set()) {
  if (!object?.$ref) return object;
  if (visited.has(object.$ref)) throw new Error(`Referência circular fora de um schema: ${object.$ref}`);
  visited.add(object.$ref);
  const { $ref, ...siblings } = object;
  return { ...dereferenceObject(document, pointer(document, $ref), visited), ...siblings };
}

function assertInternalReferences(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (typeof value.$ref === 'string' && !value.$ref.startsWith('#/')) {
    throw new Error('Referências externas não são carregadas em execução. Use npm run import:api para agrupá-las localmente.');
  }
  for (const [key, child] of Object.entries(value)) {
    if (!['enum', 'const', 'default', 'example', 'examples'].includes(key)) assertInternalReferences(child, seen);
  }
}

function specificationBasePath(document, pathItem, operation) {
  const explicit = operation?.['x-infinitegear-base-path']
    ?? pathItem?.['x-infinitegear-base-path']
    ?? document['x-infinitegear-base-path'];
  if (explicit !== undefined) return normalizeBasePath(explicit);
  if (document.swagger === '2.0') return normalizeBasePath(document.basePath || '');
  const servers = operation?.servers ?? pathItem?.servers ?? document.servers ?? [];
  const paths = new Set(servers.map(({ url }) => {
    if (typeof url !== 'string' || url.includes('{')) {
      throw new Error('Servidor com variáveis: defina x-infinitegear-base-path com o prefixo correto.');
    }
    try { return normalizeBasePath(new URL(url, 'https://local.invalid').pathname); }
    catch { throw new Error('URL de servidor inválida na especificação.'); }
  }));
  if (paths.size > 1) throw new Error('Servidores com prefixos diferentes: defina x-infinitegear-base-path explicitamente.');
  return [...paths][0] || '';
}

function normalizeBasePath(value) {
  if (typeof value !== 'string' || (value && !value.startsWith('/')) || /[?#{}\\]/.test(value)) {
    throw new Error('x-infinitegear-base-path deve conter apenas um caminho absoluto, sem domínio ou variáveis.');
  }
  if (value.startsWith('//') || value.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Prefixo da API inválido.');
  }
  return value.replace(/\/+$/, '');
}

function schemaConverter(document) {
  const definitions = {};
  const names = new Map();
  const readOnlyProperty = (schema, visited = new Set()) => {
    if (!schema || typeof schema !== 'object') return false;
    if (schema.readOnly === true) return true;
    if (schema.$ref && !visited.has(schema.$ref)) {
      const next = new Set(visited).add(schema.$ref);
      if (readOnlyProperty(pointer(document, schema.$ref), next)) return true;
    }
    return schema.allOf?.some(member => readOnlyProperty(member, visited)) || false;
  };
  const convert = (value) => {
    if (typeof value === 'boolean') return value;
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(convert);
    if (value.$ref) {
      if (!names.has(value.$ref)) {
        const name = `Model${names.size + 1}`;
        names.set(value.$ref, name);
        definitions[name] = {};
        definitions[name] = convert(pointer(document, value.$ref));
      }
      const { $ref, nullable, ...siblings } = value;
      const reference = { $ref: `#/$defs/${names.get($ref)}`, ...convert(siblings) };
      return nullable === true ? { anyOf: [reference, { type: 'null' }] } : reference;
    }
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'nullable' || key === 'xml' || key === 'discriminator') continue;
      if (key === 'exclusiveMinimum' && typeof child === 'boolean') {
        if (child && typeof value.minimum === 'number') result.exclusiveMinimum = value.minimum;
        continue;
      }
      if (key === 'exclusiveMaximum' && typeof child === 'boolean') {
        if (child && typeof value.maximum === 'number') result.exclusiveMaximum = value.maximum;
        continue;
      }
      if (key === 'minimum' && value.exclusiveMinimum === true) continue;
      if (key === 'maximum' && value.exclusiveMaximum === true) continue;
      if (key === 'properties') {
        // OpenAPI required/readOnly fields apply to responses, not request bodies.
        result[key] = Object.fromEntries(Object.entries(child)
          .filter(([, member]) => !readOnlyProperty(member))
          .map(([name, member]) => [name, convert(member)]));
      } else if (key === 'required' && value.properties) {
        result.required = child.filter(name => !readOnlyProperty(value.properties[name]));
      } else if (['patternProperties', 'dependentSchemas', '$defs', 'definitions'].includes(key)) {
        result[key] = Object.fromEntries(Object.entries(child).map(([name, member]) => [name, convert(member)]));
      } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
        result[key] = child.map(convert);
      } else if (['items', 'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'contentSchema'].includes(key)) {
        result[key] = convert(child);
      } else result[key] = clone(child);
    }
    if (value.nullable === true) {
      if (result.type) result.type = [...new Set([...(Array.isArray(result.type) ? result.type : [result.type]), 'null'])];
      else return { anyOf: [result, { type: 'null' }] };
      if (result.enum && !result.enum.includes(null)) result.enum.push(null);
    }
    if ((value.type === 'string' && ['binary', 'byte'].includes(value.format)) || value.type === 'file') {
      if (value.type === 'file') result.type = 'string';
      result.description = `${result.description ? `${result.description} ` : ''}Envie o conteúdo do arquivo codificado em base64.`;
      result.contentEncoding = 'base64';
      delete result.format;
    }
    // These OpenAPI-specific formats are annotations, not JSON Schema validators.
    if (['int32', 'int64', 'float', 'double', 'password'].includes(result.format)) delete result.format;
    return result;
  };
  return { convert, definitions };
}

function parameterSchema(parameter) {
  if (parameter.schema !== undefined) return parameter.schema;
  if (parameter.content) {
    const variants = Object.values(parameter.content);
    if (variants.length !== 1) throw new Error(`Parâmetro ${parameter.name} deve declarar apenas um tipo de conteúdo.`);
    return variants[0].schema ?? {};
  }
  const result = {};
  for (const key of ['type', 'format', 'items', 'default', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems']) {
    if (parameter[key] !== undefined) result[key] = parameter[key];
  }
  return result;
}

function authType(operation, effectivePath) {
  const declared = operation['x-infinitegear-auth'];
  if (declared !== undefined && !['account', 'partner', 'either'].includes(declared)) {
    throw new Error('x-infinitegear-auth deve ser account, partner ou either.');
  }
  if (declared) return declared;
  const route = effectivePath.toLowerCase();
  if (/\/v\d+\/company\/officehours\/?$/.test(route)) return 'account';
  return /\/v\d+\/(company|partner)(\/|$)/.test(route) ? 'partner' : 'account';
}

function authenticationScheme(document, operation) {
  const security = operation.security ?? document.security;
  if (!security) return { type: 'bearer' };
  if (!security.length || security.some((requirement) => Object.keys(requirement).length === 0)) return { type: 'none' };
  const schemes = document.components?.securitySchemes || document.securityDefinitions || {};
  for (const requirement of security) {
    const names = Object.keys(requirement);
    if (names.length !== 1) continue;
    const scheme = dereferenceObject(document, schemes[names[0]]);
    if (!scheme) continue;
    if ((scheme.type === 'http' && scheme.scheme?.toLowerCase() === 'bearer') || ['oauth2', 'openIdConnect'].includes(scheme.type)) {
      return { type: 'bearer', ...(requirement[names[0]]?.length ? { scopes: requirement[names[0]] } : {}) };
    }
    if (scheme.type === 'apiKey' && ['header', 'query', 'cookie'].includes(scheme.in) && typeof scheme.name === 'string') {
      return { type: 'apiKey', in: scheme.in, name: scheme.name };
    }
  }
  throw new Error(`Autenticação não suportada em ${operation.operationId || 'operação'}: use bearer ou uma chave de API; combinações simultâneas não são aceitas.`);
}

function safeName(id) {
  const name = `infinitegear_${id}`.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  return name.length <= 64 ? name : `${name.slice(0, 53)}_${createHash('sha256').update(id).digest('hex').slice(0, 10)}`;
}

/** Convert an already validated, locally bundled OpenAPI document into MCP operations. */
export function operationsFromDocument(document) {
  if (!document || (!/^3\.(0|1)\./.test(document.openapi || '') && document.swagger !== '2.0')) {
    throw new Error('Forneça uma especificação OpenAPI 3.0/3.1 ou Swagger 2.0.');
  }
  assertInternalReferences(document);
  const operations = [];
  for (const [route, rawPathItem] of Object.entries(document.paths || {})) {
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error(`Caminho inválido na especificação: ${route}`);
    const pathItem = dereferenceObject(document, rawPathItem);
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!METHODS.has(method)) continue;
      const operation = dereferenceObject(document, rawOperation);
      const effectivePath = `${specificationBasePath(document, pathItem, operation)}${route}`;
      const merged = new Map();
      for (const rawParameter of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
        const parameter = clone(dereferenceObject(document, rawParameter));
        if (document.swagger === '2.0' && parameter.in === 'query' && parameter.type === 'array') {
          const format = parameter.collectionFormat || 'csv';
          const styles = { csv: 'form', multi: 'form', ssv: 'spaceDelimited', pipes: 'pipeDelimited' };
          if (!styles[format]) throw new Error(`Serialização Swagger não suportada: ${format}.`);
          parameter.style = styles[format];
          parameter.explode = format === 'multi';
        }
        merged.set(`${parameter.in}:${parameter.name}`, clone(parameter));
      }
      const parameters = [...merged.values()];
      const { convert, definitions } = schemaConverter(document);
      const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {}, additionalProperties: false };
      const required = [];
      for (const [location, name] of Object.entries(PARAMETER_GROUPS)) {
        const members = parameters.filter((parameter) => parameter.in === location);
        if (!members.length) continue;
        const group = { type: 'object', properties: {}, additionalProperties: false };
        const requiredMembers = [];
        for (const parameter of members) {
          group.properties[parameter.name] = convert(parameterSchema(parameter));
          if (parameter.description && typeof group.properties[parameter.name] === 'object') {
            group.properties[parameter.name].description = parameter.description;
          }
          if (parameter.required || location === 'path') requiredMembers.push(parameter.name);
        }
        if (requiredMembers.length) { group.required = requiredMembers; required.push(name); }
        schema.properties[name] = group;
      }
      let requestBody = clone(dereferenceObject(document, operation.requestBody));
      if (document.swagger === '2.0') {
        const bodyParameter = parameters.find((parameter) => parameter.in === 'body');
        const formParameters = parameters.filter((parameter) => parameter.in === 'formData');
        if (bodyParameter || formParameters.length) {
          const bodySchema = bodyParameter?.schema || {
            type: 'object',
            properties: Object.fromEntries(formParameters.map((parameter) => [parameter.name, parameterSchema(parameter)])),
            required: formParameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
          };
          const consumes = operation.consumes || document.consumes || [formParameters.length ? 'application/x-www-form-urlencoded' : 'application/json'];
          requestBody = { required: Boolean(bodyParameter?.required || formParameters.some((parameter) => parameter.required)), content: Object.fromEntries(consumes.map((type) => [type, { schema: bodySchema }])) };
        }
      }
      if (requestBody) {
        const contents = Object.entries(requestBody.content || {});
        if (!contents.length) throw new Error(`Corpo sem tipo de conteúdo: ${method.toUpperCase()} ${effectivePath}`);
        const bodySchemas = contents.map(([, content]) => convert(content.schema ?? {}));
        schema.properties.body = bodySchemas.length === 1 ? bodySchemas[0] : { anyOf: bodySchemas };
        if (contents.length > 1) schema.properties.contentType = { type: 'string', enum: contents.map(([type]) => type) };
        if (requestBody.required) required.push('body');
      }
      if (required.length) schema.required = required;
      if (Object.keys(definitions).length) schema.$defs = definitions;
      if (requestBody) {
        requestBody.content = Object.fromEntries(Object.entries(requestBody.content).map(([type, content]) => {
          const converted = convert(content.schema ?? {});
          const completeSchema = converted && typeof converted === 'object' && Object.keys(definitions).length
            ? { ...converted, $defs: definitions }
            : converted;
          return [type, { ...content, schema: completeSchema }];
        }));
      }
      const id = operation.operationId || `${method}_${effectivePath}`;
      const authentication = authType(operation, effectivePath);
      if (authentication === 'either') {
        schema.properties.credential = {
          type: 'string',
          enum: ['account', 'partner'],
          description: 'Escolha qual token cadastrado usar: account para o token da conta ou partner para o token de parceiro. Se omitido, usa o token da conta quando disponível.',
        };
      }
      const declaredReadOnly = operation['x-infinitegear-read-only'];
      if (declaredReadOnly !== undefined && typeof declaredReadOnly !== 'boolean') {
        throw new Error('x-infinitegear-read-only deve ser true ou false.');
      }
      operations.push({
        id,
        indexSlug: operation['x-infinitegear-index-slug'],
        name: safeName(id),
        summary: operation.summary || `${method.toUpperCase()} ${effectivePath}`,
        description: operation.description || `Operação da API InfiniteGear: ${method.toUpperCase()} ${effectivePath}.`,
        method: method.toUpperCase(),
        path: effectivePath,
        group: operation.tags?.[0] || effectivePath.split('/').find(Boolean) || 'api',
        auth: authentication,
        authScheme: authenticationScheme(document, operation),
        parameters,
        ...(requestBody ? { requestBody } : {}),
        schema,
        readOnly: declaredReadOnly ?? ['get', 'head', 'options'].includes(method),
        docsUrl: operation['x-infinitegear-documentation-url'] || DOCS_URL,
      });
    }
  }
  return operations;
}

async function readDocument(filename, { bundleLocalReferences = false } = {}) {
  const parser = new SwaggerParser();
  const options = { resolve: { http: false, ...(bundleLocalReferences ? {} : { external: false }) } };
  const document = await parser.parse(filename, options);
  if (!bundleLocalReferences) assertInternalReferences(document);
  const bundled = bundleLocalReferences ? await SwaggerParser.bundle(filename, { resolve: { http: false } }) : document;
  // Validation may dereference its argument. Keep our bundled document acyclic and serializable.
  await SwaggerParser.validate(clone(bundled), { resolve: { external: false, http: false }, dereference: { circular: 'ignore' } });
  return bundled;
}

/** Load bundled specifications or an explicit local file/directory. Never resolve network references. */
export async function loadCatalog(location = process.env.INFINITEGEAR_OPENAPI || BUNDLED_DIRECTORY) {
  let entry;
  try { entry = await stat(location); }
  catch (error) {
    if (error.code === 'ENOENT' && location === BUNDLED_DIRECTORY) return [];
    throw new Error(`Não foi possível abrir a especificação OpenAPI: ${location}`, { cause: error });
  }
  const filenames = entry.isDirectory()
    ? (await readdir(location)).filter((name) => /\.(json|ya?ml)$/i.test(name)).sort().map((name) => path.join(location, name))
    : [location];
  const operations = [];
  const names = new Set();
  const routes = new Set();
  for (const filename of filenames) {
    for (const operation of operationsFromDocument(await readDocument(filename))) {
      const route = `${operation.method} ${operation.path}`;
      if (routes.has(route)) throw new Error(`Operação duplicada nas especificações: ${route}`);
      routes.add(route);
      if (names.has(operation.name)) {
        operation.name = `${operation.name.slice(0, 53)}_${createHash('sha256').update(route).digest('hex').slice(0, 10)}`;
      }
      if (names.has(operation.name)) throw new Error(`Nome de ferramenta duplicado: ${operation.name}`);
      names.add(operation.name);
      operations.push(operation);
    }
  }
  return operations;
}

function cleanAnnotations(value) {
  if (Array.isArray(value)) return value.map(cleanAnnotations);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !ANNOTATIONS.has(key) && key !== 'servers' && key !== 'host' && key !== 'schemes' && (!key.startsWith('x-') || key.startsWith('x-infinitegear-')))
    .map(([key, child]) => {
      if (['default', 'const', 'enum'].includes(key)) return [key, clone(child)];
      if (['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions', 'schemas', 'responses', 'headers', 'securitySchemes', 'securityDefinitions', 'requestBodies', 'links', 'callbacks'].includes(key)) {
        return [key, Object.fromEntries(Object.entries(child).map(([name, member]) => {
          const cleaned = cleanAnnotations(member);
          if (key === 'responses' && cleaned && !cleaned.$ref) cleaned.description = 'Resposta da API InfiniteGear.';
          return [name, cleaned];
        }))];
      }
      if (key === 'parameters' && !Array.isArray(child)) {
        return [key, Object.fromEntries(Object.entries(child).map(([name, member]) => [name, cleanAnnotations(member)]))];
      }
      return [key, cleanAnnotations(child)];
    }));
}

/** Bundle explicitly supplied local specs; preserve technical schemas and replace presentation metadata. */
export async function importOpenApi(inputs, outputDirectory = BUNDLED_DIRECTORY) {
  if (!inputs.length) throw new Error('Informe pelo menos um arquivo OpenAPI local.');
  const prepared = [];
  for (const filename of inputs) {
    if (/^[a-z][a-z\d+.-]*:/i.test(filename) && !/^[a-z]:[\\/]/i.test(filename)) {
      throw new Error('A importação aceita apenas arquivos locais, sem URLs.');
    }
    const original = await readDocument(path.resolve(filename), { bundleLocalReferences: true });
    const document = cleanAnnotations(original);
    document.info = { title: 'InfiniteGear API', version: String(original.info?.version || '1.0.0') };
    document.externalDocs = { url: DOCS_URL };
    document['x-infinitegear-base-path'] = specificationBasePath(original);
    for (const [route, rawPathItem] of Object.entries(original.paths || {})) {
      const pathItem = dereferenceObject(original, rawPathItem);
      // Materialize referenced path items to preserve their operation-level URL prefixes.
      document.paths[route] = cleanAnnotations(pathItem);
      for (const [method, rawOperation] of Object.entries(pathItem)) {
        if (!METHODS.has(method)) continue;
        const operation = dereferenceObject(original, rawOperation);
        document.paths[route][method] = cleanAnnotations(operation);
        document.paths[route][method]['x-infinitegear-base-path'] = specificationBasePath(original, pathItem, operation);
        document.paths[route][method].operationId = `${method}_${route}`.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
      }
    }
    const operations = operationsFromDocument(document);
    if (!operations.length) throw new Error(`Nenhuma operação encontrada em ${filename}.`);
    const contents = `${JSON.stringify(document, null, 2)}\n`;
    const digest = createHash('sha256').update(contents).digest('hex').slice(0, 12);
    prepared.push({ filename: `infinitegear-${digest}.json`, contents, operations: operations.length });
  }
  await mkdir(outputDirectory, { recursive: true });
  const results = [];
  for (const item of prepared) {
    const filename = path.join(outputDirectory, item.filename);
    try {
      const existing = await readFile(filename, 'utf8');
      if (existing !== item.contents) throw new Error(`O arquivo de destino já existe e é diferente: ${filename}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(filename, item.contents, { encoding: 'utf8', flag: 'wx' });
    }
    results.push({ path: filename, operations: item.operations });
  }
  return results;
}
