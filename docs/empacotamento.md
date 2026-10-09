# Gerar a extensão para desktop

O formato `.mcpb` permite instalar o servidor por um formulário em aplicativos compatíveis. A especificação e o empacotador são mantidos no [projeto MCP Bundles](https://github.com/anthropics/mcpb).

Com Node.js 22 ou superior, na pasta do projeto:

```bash
npm ci --ignore-scripts
npm test
npm run package:mcpb
```

O script cria `dist/infinitegear-mcp-<versão>.mcpb` e o arquivo de verificação `.sha256`. O pacote inclui apenas os diretórios de aplicação permitidos, o catálogo instalado e as dependências de produção instaladas pelo lockfile. Arquivos `.env`, configurações pessoais e documentos de referência na raiz não entram no pacote.

O pacote gerado inclui o catálogo de API e usa `https://api.crm.infinitegear.app` como endereço padrão. O formulário de instalação solicita o token permanente da conta; a chave de parceiro é opcional e alterações ficam desativadas inicialmente.

O pacote gerado não tem assinatura digital. Antes de distribuí-lo, confira o conteúdo e faça uma instalação em um aplicativo compatível. O empacotamento valida o manifesto, mas não confirma credenciais nem testa chamadas na conta do CRM.

A automação em **Actions → Validar e empacotar** executa testes em Linux, Windows e macOS e gera o pacote como artefato da execução. Para acessá-lo, abra uma execução concluída e baixe `infinitegear-mcp-desktop` em **Artifacts**; o GitHub pode exigir login. Extraia esse ZIP para encontrar o `.mcpb`.

Nenhuma publicação em npm ou em GitHub Releases é automática. O mantenedor pode criar uma Release e anexar o `.mcpb` e o `.sha256` depois de revisar o pacote.

## Docker em redes com proxy corporativo

O Dockerfile aceita opcionalmente um certificado CA pelo segredo de build `npm_ca`. Use somente o certificado confiável fornecido pelo administrador da rede. Ele é montado apenas durante a instalação das dependências, sem entrar na imagem:

```bash
docker build \
  --build-arg HTTPS_PROXY --build-arg HTTP_PROXY --build-arg NO_PROXY \
  --secret id=npm_ca,src=/caminho/para/ca-da-rede.pem \
  -t infinitegear-mcp:local .
```

Esses argumentos reutilizam as variáveis de proxy já configuradas no terminal. Nunca desative a verificação TLS para contornar um erro de certificado.
