#!/usr/bin/env node
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import SwaggerParser from '@apidevtools/swagger-parser';

// Maintainer utility: merge locally downloaded, official per-operation contracts.
// The source directory is explicit; this script never downloads documentation.
const source = process.argv[2];
const brandIndexPath = process.argv[3];
if (!source || !brandIndexPath) {
  console.error('Uso: node scripts/build-reference-catalog.mjs PASTA_DOS_CONTRATOS INDICE_INFINITEGEAR.txt');
  process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'data', 'openapi');
const brandIndex = await readFile(resolve(brandIndexPath), 'utf8');
const brandLinks = new Map([...brandIndex.matchAll(/\]\((https:\/\/infinitegear\.readme\.io\/reference\/([^)]*)\.md)\)/g)].map(([, url, slug]) => [decodeURIComponent(slug), url]));
const methods = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
const documents = new Map();
const coverage = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const file of (await readdir(resolve(source))).filter(name => name.endsWith('.json')).sort()) {
  const rawText = await readFile(join(resolve(source), file), 'utf8');
  const input = JSON.parse(rawText);
  if (input.servers?.length !== 1) throw new Error(`Confirme o servidor único em ${file}.`);
  const prefix = new URL(input.servers[0].url).pathname.replace(/\/$/, '');
  if (!['/core', '/chat', '/crm'].includes(prefix)) throw new Error(`Prefixo não reconhecido: ${prefix}.`);
  const group = prefix.slice(1);
  const slug = file.slice(0, -5);
  let document = documents.get(group);
  if (!document) {
    document = {
      openapi: '3.0.1', info: { title: `InfiniteGear ${group.toUpperCase()}`, version: '1.0' },
      servers: [{ url: `https://api.crm.infinitegear.app${prefix}` }],
      paths: {}, components: { schemas: {}, securitySchemes: { Bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ Bearer: [] }], externalDocs: { url: 'https://infinitegear.readme.io/llms.txt' },
    };
    documents.set(group, document);
  }
  const bearer = input.components?.securitySchemes?.Bearer;
  if (!(bearer?.type === 'apiKey' && bearer.in === 'header' && bearer.name === 'Authorization' && /Bearer/.test(bearer.description || ''))) {
    throw new Error(`Confirme o contrato de autenticação em ${file}.`);
  }
  for (const [name, schema] of Object.entries(input.components?.schemas || {})) {
    if (document.components.schemas[name] && !same(document.components.schemas[name], schema)) throw new Error(`Modelo divergente: ${group}/${name}.`);
    document.components.schemas[name] = schema;
  }
  for (const [path, pathItem] of Object.entries(input.paths)) {
    document.paths[path] ??= {};
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method)) throw new Error(`Campo não esperado no fragmento: ${method}.`);
      if (document.paths[path][method]) throw new Error(`Operação duplicada: ${group} ${method} ${path}.`);
      if (operation.requestBody?.content?.['application/json']) {
        const media = operation.requestBody.content;
        if (!Object.values(media).every(value => same(value, media['application/json']))) throw new Error(`Tipos de corpo divergentes: ${file}.`);
        // Select the concrete, documented JSON representation; don't advertise a wildcard MIME.
        operation.requestBody.content = { 'application/json': media['application/json'] };
      }
      operation.operationId = `${group}_${slug}`;
      operation.summary = `${operation.tags?.[0] || group.toUpperCase()} · ${operation.summary || method.toUpperCase()}`;
      operation['x-infinitegear-index-slug'] = slug;
      operation['x-infinitegear-documentation-url'] = brandLinks.get(slug) || 'https://infinitegear.readme.io/reference';
      if (group === 'core' && method === 'post' && path === '/v1/contact/filter') operation['x-infinitegear-read-only'] = true;
      document.paths[path][method] = operation;
      coverage.push({ id: slug, group, method: method.toUpperCase(), path: `${prefix}${path}`, documentationUrl: operation['x-infinitegear-documentation-url'], sourceSha256: createHash('sha256').update(rawText).digest('hex') });
    }
  }
}

for (const document of documents.values()) {
  const invoiceType = document.components.schemas.PublicCompanyDTO?.properties?.invoiceType;
  if (invoiceType) {
    // This is response-only provider metadata. Keep its wire type and value untouched,
    // without publishing provider-specific labels as product enums.
    delete invoiceType.enum;
    invoiceType.description = 'Tipo de faturamento retornado pela API.';
  }
  await SwaggerParser.validate(structuredClone(document), { resolve: { external: false, http: false } });
}
if (coverage.length !== 119) throw new Error(`Cobertura inesperada: ${coverage.length}; revise o índice antes de atualizar a distribuição.`);
await mkdir(destination, { recursive: true });
for (const [group, document] of documents) await writeFile(join(destination, `${group}.json`), `${JSON.stringify(document, null, 2)}\n`);
await writeFile(join(root, 'data', 'api-coverage.json'), `${JSON.stringify({ source: 'Contratos oficiais de referência, adaptados para InfiniteGear', date: new Date().toISOString().slice(0, 10), indexedOperations: coverage.length, operations: coverage }, null, 2)}\n`);
console.log(`Catálogo InfiniteGear: ${coverage.length} operações em ${documents.size} serviços.`);
