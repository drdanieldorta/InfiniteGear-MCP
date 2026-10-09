#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const outputDir = join(root, 'dist');
await mkdir(outputDir, { recursive: true });
const stage = await mkdtemp(join(outputDir, '.mcpb-stage-'));
const archive = join(outputDir, `infinitegear-mcp-${pkg.version}.mcpb`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache || join(root, '.npm-cache') },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`O comando de empacotamento falhou (código ${result.status}).`);
}

try {
  // Somente arquivos públicos conhecidos entram no pacote. Não copiar .env,
  // configurações locais, documentos de referência ou o checkout inteiro.
  for (const name of ['package.json', 'package-lock.json', 'src', 'data', 'public', 'README.md', 'LICENSE']) {
    const source = join(root, name);
    try {
      await stat(source);
    } catch (error) {
      if (error.code === 'ENOENT' && ['public', 'README.md', 'LICENSE'].includes(name)) continue;
      throw error;
    }
    await cp(source, join(stage, name), {
      recursive: true,
      dereference: false,
      filter: async (candidate) => {
        const filename = basename(candidate);
        if (filename === '.env' || filename.startsWith('.env.') || filename === '.npmrc') return false;
        if ((await lstat(candidate)).isSymbolicLink()) {
          throw new Error(`Links simbólicos não são permitidos nos arquivos de aplicação: ${filename}`);
        }
        return true;
      },
    });
  }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const npmCli = process.env.npm_execpath;
  const installArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (npmCli) {
    run(process.execPath, [npmCli, ...installArgs], stage);
  } else if (process.platform === 'win32') {
    throw new Error('No Windows, execute este script usando npm run package:mcpb.');
  } else {
    run('npm', installArgs, stage);
  }
  const mcpbCli = join(dirname(require.resolve('@anthropic-ai/mcpb')), 'cli', 'cli.js');
  run(process.execPath, [mcpbCli, 'validate', join(stage, 'manifest.json')], root);
  run(process.execPath, [mcpbCli, 'pack', stage, archive], root);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  console.log(`\nPacote pronto: ${archive}\nSHA-256: ${archive}.sha256`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
