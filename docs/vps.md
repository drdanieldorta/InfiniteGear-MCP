# Instalar em uma VPS com Docker

Este caminho é para quem já sabe acessar uma VPS por SSH. Você precisa de Docker Engine com o plugin Compose, Git e um token permanente da API InfiniteGear. Gere esse token no CRM em **Ajustes → Integrações → Integração via API**. O endereço da API e o catálogo de operações já vêm configurados. Consulte a [instalação oficial do Docker](https://docs.docker.com/engine/install/) para seu sistema.

O contêiner roda sem usuário root. O Compose publica a porta 3000 **somente em `127.0.0.1`**. Para acesso pela internet, coloque HTTPS na frente do servidor e use um cliente MCP que aceite **Streamable HTTP com cabeçalho Authorization personalizado**.

## 1 · Baixe e preencha os dados

```bash
git clone https://github.com/drdanieldorta/Flw-MCP-v2.git
cd Flw-MCP-v2
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
nano .env
```

Copie o valor aleatório gerado para `INFINITEGEAR_MCP_TOKEN`. Esse é o segredo que protege **este servidor MCP**; ele é diferente do token de acesso ao CRM. Cole o token do CRM em `INFINITEGEAR_API_TOKEN`, sem a palavra `Bearer`. A variável `INFINITEGEAR_API_URL` já contém `https://api.crm.infinitegear.app`; altere apenas se o administrador indicar outro endereço de API.

Mantenha `INFINITEGEAR_ALLOW_WRITES=false` para começar. O token de parceiro é opcional, necessário apenas para operações que exigem essa credencial; administradores de parceiros o geram em **Admin → Personalizar → Integração**. O arquivo `.env` não deve ser enviado ao GitHub nem compartilhado.

## 2 · Inicie

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3000/health
```

O endpoint `/health` indica que o processo está respondendo; não testa as credenciais do CRM. Consulte erros com `docker compose logs --tail=100`. O catálogo incluído na imagem fornece as operações de API.

Não exponha o assistente de configuração local em uma VPS. No contêiner, a configuração vem das variáveis de `.env`.

## 3 · Escolha o acesso

### Acesso privado por SSH

No seu computador, deixe este comando aberto, substituindo `USUARIO` e `IP_DA_VPS`:

```bash
ssh -N -L 3000:127.0.0.1:3000 USUARIO@IP_DA_VPS
```

Configure o cliente MCP com URL `http://127.0.0.1:3000/mcp` e cabeçalho `Authorization: Bearer SEU_TOKEN_MCP`. Substitua `SEU_TOKEN_MCP` pelo valor de `INFINITEGEAR_MCP_TOKEN`. O túnel SSH cifra o trajeto até a VPS.

### Acesso por domínio e HTTPS

1. Aponte um domínio seu para a VPS.
2. Instale e configure um proxy HTTPS, como [Caddy](https://caddyserver.com/docs/install), no host.
3. Use a configuração abaixo, substituindo `mcp.seudominio.com` pelo domínio real:

```caddyfile
mcp.seudominio.com {
    reverse_proxy 127.0.0.1:3000
}
```

Libere as portas 80/443 para o proxy conforme a configuração do firewall. Mantenha a porta 3000 vinculada ao loopback no Compose. O proxy precisa encaminhar `Authorization` e permitir as respostas em streaming do MCP; o Caddy faz isso com essa configuração.

Defina também `INFINITEGEAR_PUBLIC_URL=https://mcp.seudominio.com` no `.env`, usando seu domínio real, e execute `docker compose up -d` novamente. Assim o servidor aceita esse endereço no cabeçalho `Origin` dos clientes que o enviam.

No aplicativo de IA, adicione:

| Campo | Valor |
| --- | --- |
| Transporte | Streamable HTTP |
| URL | `https://mcp.seudominio.com/mcp` |
| Cabeçalho | `Authorization` |
| Valor do cabeçalho | `Bearer SEU_TOKEN_MCP` |

Este servidor usa autenticação por token compartilhado. Clientes que exigem OAuth e não permitem um cabeçalho de autorização personalizado precisam de uma integração adicional; essa integração não está incluída. Para computadores pessoais, a [instalação local por stdio](instalacao-local.md) costuma ser mais simples.

Depois de conectar o cliente, peça **“Liste até 5 contatos do meu InfiniteGear, sem alterar nada.”** Essa consulta confere o acesso ao CRM pela instalação da VPS. Se a API retornar 401 ou 403, confira o token permanente e suas permissões no CRM. O token configurado no cliente MCP é `INFINITEGEAR_MCP_TOKEN`; o token do CRM permanece na VPS.

## Atualizar ou parar

Antes de atualizar, preserve seu `.env` e qualquer catálogo de API importado. Atualize uma cópia sem mudanças locais:

```bash
git pull --ff-only
docker compose up -d --build
```

Para parar: `docker compose down`. As credenciais continuam em `.env`; excluir o contêiner não exclui esse arquivo. Se alterar tokens ou permissões em `.env`, execute novamente `docker compose up -d` para recriar o serviço.
