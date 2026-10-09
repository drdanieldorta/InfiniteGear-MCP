# Instalar no seu computador

O InfiniteGear MCP conecta um aplicativo de IA compatível com MCP ao seu CRM. O assistente abre no navegador e ajuda a configurar a conexão, sem precisar editar código.

![Três etapas: baixar, configurar e conectar](assets/instalacao.svg)

## 1 · Prepare o computador

Você precisa de acesso à internet, um aplicativo compatível com MCP e uma **chave de acesso** da sua conta InfiniteGear. O endereço da API e o catálogo de operações já vêm configurados.

**Pegue sua chave:** entre no InfiniteGear → **Ajustes** → **Integrações** → **Integração via API** → gere um **token permanente**. Guarde esse token para colar no assistente. Se essa opção não aparecer, peça ao administrador da conta para gerar a chave com as permissões de que você precisa.

1. Abra [nodejs.org](https://nodejs.org/) e instale a versão **LTS** (22 ou superior). Use as opções padrão.
2. Volte à [página inicial do repositório](https://github.com/drdanieldorta/Flw-MCP-v2).
3. Clique no botão verde **Code** → **Download ZIP**.
4. Extraia o ZIP: no Windows, botão direito → **Extrair tudo**; no macOS, dê dois cliques no ZIP. Guarde a pasta extraída em um lugar permanente, como Documentos. O aplicativo de IA usará os arquivos dessa pasta.

## 2 · Abra o instalador

| Seu computador | O que abrir na pasta extraída |
| --- | --- |
| **Windows** | Dê dois cliques em **Instalar-Windows.cmd**. |
| **macOS** | Dê dois cliques em **Instalar-macOS.command**. |
| **Linux** | Abra um terminal na pasta e execute `bash instalar-linux.sh`. |

O instalador baixa as dependências e abre o assistente local. Mantenha a janela do terminal aberta durante a configuração. Se o navegador não abrir sozinho, copie **o endereço completo mostrado no terminal**, incluindo a parte depois de `#`. Ele começa com `http://127.0.0.1:17841/`.

No macOS, se aparecer “sem permissão para executar”, abra **Terminal**, digite `bash ` (com um espaço no final), arraste **Instalar-macOS.command** para o Terminal e pressione Enter. Se o sistema pedir confirmação de segurança, confira que o arquivo veio deste repositório antes de permitir sua abertura.

## 3 · Configure e conecte

![Assistente InfiniteGear: onde gerar a chave, campo para colar o token e botão Testar conexão](assets/configuracao-conta.png)

1. Cole sua **chave de acesso** no assistente, sem escrever a palavra `Bearer`.
2. Clique em **Testar conexão** e confira a mensagem de sucesso. O teste faz apenas uma consulta, sem alterar dados.
3. Mantenha **permitir alterações** desativado para começar em modo de leitura.
4. Clique em **Salvar configuração**. Escolha seu aplicativo de IA no passo 3 do assistente e siga as instruções exibidas para copiar a configuração.
5. Encerre seu aplicativo de IA por completo e abra novamente depois de adicionar o MCP.

Você não precisa preencher o endereço da API: `https://api.crm.infinitegear.app` já está configurado. Em **Opções avançadas**, ele pode ser alterado se o administrador indicar outro endereço. A chave de parceiro é opcional e serve para operações de administração de parceiros; quem tem esse acesso a gera em **Admin → Personalizar → Integração**.

Para entender os endereços e as credenciais, consulte [Conexão com o InfiniteGear](conexao-infinitegear.md).

O token fica no arquivo local de configuração do seu usuário, fora do repositório. Nunca envie esse arquivo, o token ou capturas de tela com credenciais ao GitHub. A janela do assistente pode ser fechada após a configuração; o aplicativo de IA inicia o servidor MCP quando precisar.

Para conferir tudo no aplicativo de IA, peça: **“Liste até 5 contatos do meu InfiniteGear, sem alterar nada.”** O aplicativo deve mostrar uma ferramenta do InfiniteGear e pedir autorização conforme suas configurações. As informações disponíveis dependem das permissões da chave e dos recursos contratados pela conta.

## Alternativa: extensão para Claude Desktop

Um arquivo **`.mcpb`** reúne o servidor e suas dependências. Em versões compatíveis do Claude Desktop para macOS/Windows, abra esse arquivo e preencha o formulário de configuração da extensão. O aplicativo fornece o Node.js; não é necessário instalar dependências manualmente por esse caminho.

Se você recebeu o arquivo **`infinitegear-mcp-<versão>.mcpb`** do mantenedor:

1. Abra o arquivo com o Claude Desktop. Se necessário, entre em **Configurações → Extensões** e escolha instalar uma extensão a partir de um arquivo; o nome da opção depende da versão.
2. Confira o nome **InfiniteGear MCP** e confirme a instalação.
3. Cole seu **token de acesso**, mantenha a URL preenchida e **Permitir alterações no CRM** desativado.
4. Salve, ative a extensão e faça a primeira consulta sugerida acima.

Não é necessário executar o instalador ou copiar JSON quando você usa a extensão. Instale por apenas um dos caminhos para evitar duas conexões com o mesmo CRM.

O pacote ainda precisa ser publicado pelo mantenedor para aparecer em [Releases](https://github.com/drdanieldorta/Flw-MCP-v2/releases). Se não houver um `.mcpb` disponível, siga o instalador acima. Quem desenvolve o projeto pode gerá-lo conforme [Empacotamento](empacotamento.md); uma execução bem-sucedida do workflow também o disponibiliza nos artefatos de Actions.

## Se algo não funcionar

| Mensagem ou situação | Próximo passo |
| --- | --- |
| “Node.js não encontrado” | Instale o Node.js LTS, feche a janela do instalador e abra o arquivo novamente. |
| Falha ao baixar dependências | Confira a internet e acesso a `registry.npmjs.org`, então execute novamente. |
| O navegador não abriu | Copie o endereço completo mostrado no terminal, incluindo a parte depois de `#`, para a barra de endereços do navegador. |
| Endereço local já está em uso | Feche o assistente aberto anteriormente e tente novamente. |
| API retorna 401 ou 403 | Confirme o token, suas permissões e se ele pertence à URL da API informada. |
| A ferramenta de alteração está bloqueada | Ative alterações no assistente somente se quiser permitir mudanças no CRM; reinicie o cliente de IA. |
| O MCP não aparece no aplicativo de IA | Confira a configuração gerada, mantenha a pasta de instalação no mesmo local e reinicie o aplicativo. |
| “Não foi possível carregar o catálogo” | Reabra a instalação com os arquivos originais. Se você configurou uma definição personalizada, confira o caminho desse arquivo. |

Para verificar o ambiente, abra um terminal na pasta e execute `npm run doctor`. O diagnóstico confere a configuração local; **Testar conexão** no assistente verifica o acesso à sua conta. Se você mudar as permissões da chave ou ativar alterações, reinicie o aplicativo de IA para atualizar a conexão.

### Usar uma definição de API personalizada (avançado)

O catálogo oficial já está incluído; **esta etapa não é necessária para instalar**. Use-a apenas se o suporte InfiniteGear fornecer um novo arquivo **OpenAPI/Swagger JSON oficial**. O arquivo `llms.txt` é um índice de documentação e não substitui essa definição.

Na pasta do projeto, execute:

```bash
npm run import:api -- "/caminho/para/openapi.json"
```

Use o caminho real do arquivo, entre aspas se contiver espaços. Confira o resultado da importação e reinicie o aplicativo de IA. O site `infinitegear.readme.io` serve para ler a documentação; não o informe como endereço da API.

### Remover

Remova a conexão MCP do aplicativo de IA e depois exclua a pasta baixada. Se também quiser apagar as credenciais, exclua `~/.config/infinitegear-mcp/config.json` (Windows: `%USERPROFILE%\.config\infinitegear-mcp\config.json`). Uma instalação por `.mcpb` é removida pelo próprio aplicativo que instalou a extensão.
