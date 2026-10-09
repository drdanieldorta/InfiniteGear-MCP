# Definição da API InfiniteGear

Este guia é para o responsável pela distribuição. O catálogo e o endereço da API já estão incluídos; quem instala normalmente informa apenas sua chave permanente.

## O que está disponível

O índice `llms.txt` aponta para **119 operações** — 57 Core, 50 Chat e 12 CRM — e 16 guias. Os contratos completos foram extraídos das páginas detalhadas e agrupados em `data/openapi/core.json`, `chat.json` e `crm.json`. O guia atual de login integrado foi transcrito em `auth.json`, totalizando **120 operações executáveis**.

O catálogo usa as definições atuais de campos e rotas com o domínio whitelabel **`https://api.crm.infinitegear.app`**, confirmado na documentação InfiniteGear. Mantém os prefixos `/core`, `/chat`, `/crm` e `/auth`. A documentação da marca pode mostrar versões anteriores de algumas rotas; o catálogo inclui as versões atuais da fonte de referência fornecida para este projeto.

O arquivo `data/api-coverage.json` relaciona as 119 operações indexadas e os hashes dos contratos de origem. O login integrado é uma operação adicional descrita em guia, não um fragmento OpenAPI exportado. As descrições, nomes e URLs publicados no projeto usam a marca InfiniteGear.

A distribuição usa `application/json`, representação concreta documentada para todos os corpos. A declaração de autenticação do contrato original é normalizada para HTTP Bearer conforme as instruções explícitas do guia. Modelos e parâmetros são mantidos; campos `readOnly` são omitidos dos argumentos de entrada. O enum de faturamento exclusivo de respostas permanece um campo string, sem publicar rótulos internos de provedor; valores retornados pela API não são reescritos.

Por padrão são expostas **49 consultas** e a busca na documentação. Isso inclui `POST /core/v1/contact/filter`, uma consulta documentada. Ao habilitar alterações, ficam disponíveis as 120 operações e o helper `infinitegear_upload_arquivo`, além da busca — **122 ferramentas** ao todo.

## Como atualizar o catálogo

1. Obtenha com o suporte InfiniteGear os arquivos **OpenAPI 3.0/3.1 ou Swagger 2.0**, em JSON ou YAML, correspondentes à versão da conta. Pode haver arquivos separados para Core, Chat e CRM.
2. Confirme que a versão corresponde à conta e que as chamadas devem continuar usando a API InfiniteGear. Não use o domínio da documentação como API.
3. Para testar contratos alternativos sem sobrepor os incluídos, importe em uma pasta separada:

```bash
npm run import:api -- "/caminho/core.json" "/caminho/chat.json" "/caminho/crm.json" --out "/caminho/catalogo-novo"
```

Use somente os arquivos que você realmente recebeu e aponte `INFINITEGEAR_OPENAPI` para essa pasta. A importação agrupa referências **locais**, valida os contratos e grava JSON. Referências externas por HTTP não são baixadas. O importador genérico remove metadados visuais; a distribuição incluída preserva as descrições conferidas e adaptadas para InfiniteGear. Não adicione versões duplicadas a `data/openapi/`.

O host `servers` do contrato não é usado para enviar credenciais: o destino sempre vem da URL configurada. Prefixos de caminho, como `/core`, são preservados. Servidores com prefixos ambíguos exigem informar `x-infinitegear-base-path` no contrato local, depois de confirmar o prefixo correto.

4. Execute `npm test`, configure a conta com `npm run setup` e clique em **Testar conexão**. Alternativamente, execute `npm run doctor`. O diagnóstico consulta uma operação GET sem parâmetros obrigatórios e não altera dados.
5. Confira as ferramentas de cada grupo e valide consultas representativas na conta de teste. Operações de alteração precisam de testes separados, com registros de teste e autorização para alterar esses dados.
6. Gere novamente o `.mcpb` ou reconstrua a imagem Docker. O catálogo instalado faz parte desses pacotes. Teste o pacote final antes de disponibilizá-lo a outras pessoas.

Uma importação repetida do mesmo arquivo é idempotente. Uma versão diferente gera outro arquivo; remova conscientemente a especificação antiga substituída para evitar rotas duplicadas. O carregador recusa duplicatas em vez de escolher silenciosamente uma versão.

Para refazer especificamente os três serviços incluídos, o mantenedor pode usar `node scripts/build-reference-catalog.mjs PASTA_DOS_FRAGMENTOS INDICE_INFINITEGEAR.txt`, fornecendo os 119 fragmentos JSON obtidos das páginas oficiais. O script não baixa documentação nem contém um domínio alternativo de API. Ele valida consistência dos modelos e quantidade de operações; mudanças no índice exigem revisar essa cobertura antes de publicar uma atualização.

## Autenticação e permissões

| Configuração | Uso |
| --- | --- |
| `INFINITEGEAR_API_URL` | Opcional; padrão `https://api.crm.infinitegear.app`. HTTPS é obrigatório fora de testes em loopback. |
| `INFINITEGEAR_API_TOKEN` | Token da conta. Não envie no chat nem inclua em commits. |
| `INFINITEGEAR_PARTNER_TOKEN` | Opcional; exigido nas operações de contas/parceiros. |
| `INFINITEGEAR_ALLOW_WRITES` | `false` por padrão; `true` habilita ferramentas que alteram dados. |
| `INFINITEGEAR_CONFIG` | Caminho opcional do arquivo de configuração local. |
| `INFINITEGEAR_OPENAPI` | Caminho opcional de uma especificação local ou pasta de contratos. |
| `INFINITEGEAR_MCP_TOKEN` | Senha exclusiva com pelo menos 32 caracteres para o transporte HTTP. |
| `INFINITEGEAR_PUBLIC_URL` | Origem pública do MCP para clientes HTTP que enviam o cabeçalho Origin. |

Variáveis de ambiente prevalecem sobre o arquivo local. O arquivo é gravado com permissões restritas em sistemas Unix; no Windows, o acesso depende das permissões da pasta do usuário. Ele contém segredos em texto e deve permanecer privado.

A autenticação segue o contrato importado: Bearer ou chave de API em cabeçalho, query ou cookie. Contratos OAuth podem usar um token Bearer já emitido; o projeto não implementa a obtenção nem a renovação desses tokens. Basic, mTLS e combinações simultâneas de esquemas não são implementadas e são recusadas explicitamente. Se o contrato omitir autenticação, o padrão é Bearer; confirme esse formato com o fornecedor antes da validação real.

O índice identifica gestão de contas e faturamento como operações de parceiro. O catálogo trata as rotas `/vN/company` e `/vN/partner` como parceiro, exceto `/company/officehours`. O login integrado aceita ambas as credenciais e permite escolher `credential: account` ou `partner`; sem escolha, prefere a conta quando configurada. A extensão `x-infinitegear-auth` registra essas regras no contrato.

Para testar os dois níveis com consultas: `npm run doctor` e `npm run doctor -- --partner`. Esses comandos não listam os dados da conta nem imprimem os tokens. Em ambientes cloud, configure `INFINITEGEAR_API_TOKEN` e `INFINITEGEAR_PARTNER_TOKEN` como secrets destinados a `api.crm.infinitegear.app`; não inclua seus valores em arquivos do repositório.

## Limites conhecidos

- Os 120 contratos passaram por validação de schema e testes com respostas simuladas. A validação autenticada em conta real ainda depende dos tokens; os testes automatizados não enviam mensagens nem alteram dados reais.
- Listagens retornam a página solicitada; a IA deve usar a paginação declarada. Não há varredura automática de toda a conta.
- Envios não são repetidos automaticamente após erro, para reduzir duplicações. Depois de um timeout, confira o resultado antes de repetir uma alteração.
- Respostas acima de 4 MiB são recusadas; use filtros ou páginas menores. O transporte HTTP aceita requisições de até 12 MiB.
- `infinitegear_upload_arquivo` aceita bytes em base64, solicita a URL de upload, envia o arquivo por PUT e registra o ID. O limite local é de **8 MiB** antes de codificar, não um limite atribuído ao CRM. Somente o domínio de armazenamento publicado no guia de firewall, `wts-storage.s3.sa-east-1.amazonaws.com`, é permitido; o token do CRM nunca é enviado a ele. A ferramenta não lê caminhos arbitrários no disco.
- Webhooks podem ser configurados se houver operações correspondentes no contrato; o MCP não é um receptor de eventos webhook.
- Formatos e autenticações não suportados geram erro explícito. Importar um contrato não prova que todas as operações funcionem em produção.

Consulte o [índice fornecido](api-reference-index.md) e a [documentação InfiniteGear](https://infinitegear.readme.io/llms.txt).
