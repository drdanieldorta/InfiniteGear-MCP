# Conectar sua conta InfiniteGear

O endereço da API já vem preenchido. Você precisa de um token criado dentro da sua conta; cole-o no assistente aberto por `npm run setup`, nunca em conversas, issues ou commits.

## 1. Confira o endereço

A documentação oficial InfiniteGear publica este endereço de API:

```text
https://api.crm.infinitegear.app
```

Use esse endereço completo no campo **URL da API**, sem acrescentar `/core`, `/chat` ou `/crm`. O catálogo do MCP acrescenta automaticamente o prefixo correto para cada operação.

| Área | Endereço publicado | Exemplo de consulta |
| --- | --- | --- |
| Core — contatos, equipes e contas | `https://api.crm.infinitegear.app/core` | `GET /core/v1/contact` |
| Chat — conversas e mensagens | `https://api.crm.infinitegear.app/chat` | `GET /chat/v1/session` |
| CRM — painéis e cards | `https://api.crm.infinitegear.app/crm` | `GET /crm/v1/panel/card` |

Esses endereços vêm dos contratos publicados nas páginas de [contatos](https://infinitegear.readme.io/reference/get_v1-contact), [conversas](https://infinitegear.readme.io/reference/get_v1-session) e [cards](https://infinitegear.readme.io/reference/get_v1-panel-card). O [guia de firewall](https://infinitegear.readme.io/reference/informa%C3%A7%C3%B5es-para-firewall) também informa esse domínio de API.

Se o suporte da sua conta fornecer outro endereço de API InfiniteGear, use o endereço confirmado por ele. O domínio da documentação e o endereço de login não substituem automaticamente o endereço da API.

## 2. Crie o token da sua conta

Na plataforma InfiniteGear:

1. Abra **Ajustes**.
2. Entre em **Integrações**.
3. Abra **Integração via API → Configurar**.
4. Clique em **Novo** e dê um nome, por exemplo, **InfiniteGear MCP**.
5. Copie o token e cole no campo **Token da conta** do assistente.

Cole somente o token, sem escrever `Bearer` antes dele. O MCP monta o cabeçalho `Authorization: Bearer ...` automaticamente. O token permanente permite acesso à conta até ser revogado na plataforma.

Fontes: [criar token para integração](https://infinitegear.readme.io/reference/criar-token-para-integra%C3%A7%C3%A3o) e [autenticação](https://infinitegear.readme.io/reference/autentica%C3%A7%C3%A3o).

## 3. Token de parceiro, somente se necessário

Para gerenciar contas de clientes ou consultar o faturamento de parceiro, gere um **Token de Parceiro** em **Admin → Personalizar → Integração**. Cole esse token no campo separado de parceiro do assistente.

O token de parceiro é usado nas operações de **Gestão de Contas** e **Parceiros**. O login integrado também aceita esse token. Para consultar os contatos e as conversas de uma conta, continue usando o token da própria conta. Você pode deixar o campo de parceiro vazio quando não precisar dessas operações administrativas.

Fontes: [gestão de contas](https://infinitegear.readme.io/reference/get_v1-company) e [relatório de faturamento](https://infinitegear.readme.io/reference/get_v1-partner-billing-report).

## 4. Teste a conexão

No assistente, clique em **Testar conexão**. Em uma instalação por terminal, execute:

```bash
npm run doctor
```

Para verificar o token de parceiro com uma consulta administrativa: `npm run doctor -- --partner`.

O diagnóstico faz uma consulta e não altera dados. Se a consulta funcionar, salve a configuração e conecte seu aplicativo de IA seguindo o [guia de instalação](instalacao-local.md).

| Resultado | O que conferir |
| --- | --- |
| Falha ao resolver o domínio ou ao conectar | Endereço da API e liberação de `api.crm.infinitegear.app` na rede/firewall. |
| `401` retornado pela API | Token copiado por inteiro, sem `Bearer` duplicado, e ainda ativo. |
| `403` retornado pela API | Permissão da conta para a operação e uso do tipo correto de token. |
| `403` antes de conectar, emitido por um proxy | Regras de acesso à internet do computador ou ambiente; a requisição pode não ter chegado à API. |
| `404` retornado pela API | URL da API e compatibilidade da operação com a versão da sua conta. |

### Verificação desta documentação

As páginas detalhadas de autenticação e contratos foram consultadas com sucesso. O endereço acima foi confirmado na documentação; o acesso a uma conta real ainda exige testar com as credenciais dessa conta. Neste ambiente de desenvolvimento, as tentativas de consulta sem credenciais ao domínio da API foram interrompidas pelo proxy antes de receber uma resposta da API.
