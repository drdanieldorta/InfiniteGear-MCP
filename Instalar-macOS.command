#!/usr/bin/env bash
set -eu
cd -- "$(dirname -- "$0")"
finish() {
  if [ -t 0 ]; then
    printf '\nPressione Enter para fechar... '
    read -r _infinitegear_answer || true
  fi
}
trap finish EXIT
printf '\n  InfiniteGear MCP — instalação guiada\n\n'
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Instale o Node.js LTS em https://nodejs.org/ e abra este arquivo novamente.\n'
  exit 1
fi
if ! node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'; then
  printf 'É necessário Node.js 22 ou superior. Baixe o LTS em https://nodejs.org/\n'
  exit 1
fi
printf '[1/2] Preparando os arquivos. Aguarde...\n'
npm ci --omit=dev --ignore-scripts --no-fund --cache .npm-cache
printf '\n[2/2] Abrindo o assistente no navegador...\nMantenha esta janela aberta durante a configuração.\n'
node src/cli.js setup
