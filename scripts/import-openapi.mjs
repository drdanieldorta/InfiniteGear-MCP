#!/usr/bin/env node
import path from 'node:path';
import { importOpenApi } from '../src/catalog.js';

const arguments_ = process.argv.slice(2);
const inputs = [];
let outputDirectory;
try {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--out') {
      const value = arguments_[++index];
      if (!value || value.startsWith('--')) throw new Error('Informe a pasta após --out.');
      outputDirectory = path.resolve(value);
    } else if (argument === '--help' || argument === '-h') {
      console.log('Uso: npm run import:api -- arquivo.json [outro.yaml ...] [--out pasta]\n\nImporta arquivos locais e referências locais; nenhum schema é baixado da rede.\nSubstitui metadados visuais por InfiniteGear e descarta os domínios dos servidores.');
      process.exit(0);
    } else if (argument.startsWith('-')) {
      throw new Error(`Opção desconhecida: ${argument}`);
    } else inputs.push(argument);
  }
  const imported = await importOpenApi(inputs, outputDirectory);
  for (const item of imported) console.log(`${item.operations} operações: ${item.path}`);
  console.log('Importação concluída. Configure a URL real da API InfiniteGear antes de iniciar o MCP.');
} catch (error) {
  console.error(`Não foi possível importar: ${error.message}`);
  process.exitCode = 1;
}
