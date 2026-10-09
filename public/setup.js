(() => {
  'use strict';
  const setupToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
  // The setup token stays in this page's memory; API keys are never put in browser storage.
  window.history.replaceState(null, '', window.location.pathname);
  const $ = (id) => document.getElementById(id);
  const defaultApiUrl = 'https://api.crm.infinitegear.app';
  let hasSavedToken = false;
  let clientConfigurations;
  let saved = false;
  let busy = false;
  let apiCatalogReady = false;
  let connectionVerified = false;
  let formRevision = 0;

  function updateProgress() {
    $('progress-connect').className = connectionVerified ? 'complete' : 'current';
    $('progress-save').className = saved ? 'complete' : connectionVerified ? 'current' : '';
    $('progress-client').className = saved ? 'current' : '';
  }

  function updateCatalog(status) {
    apiCatalogReady = status.apiCatalogReady === true;
    if (!apiCatalogReady) {
      connectionVerified = false;
      notice('catalog-notice', 'Não foi possível carregar o catálogo de operações da API. Suas chaves podem ser salvas, mas as consultas ao CRM dependem desse catálogo. Reabra o conector com os arquivos originais; se você usa uma definição de API personalizada, confira o arquivo configurado.', 'warning');
      $('permission-description').textContent = 'Esta opção prepara as permissões. O acesso aos dados do CRM ficará disponível depois que o catálogo de operações for carregado.';
      $('try-it-title').textContent = 'Configuração preparada; catálogo indisponível';
      $('try-it-description').textContent = 'A IA pode verificar o estado do conector, mas o catálogo precisa estar disponível para acessar os dados do CRM. Confira a instalação antes de testar novamente.';
    } else {
      $('catalog-notice').hidden = true;
      $('permission-description').textContent = 'Com a conexão verificada, a IA poderá consultar seus dados. Criar, editar, excluir e enviar mensagens fica bloqueado por padrão.';
      $('try-it-title').textContent = connectionVerified ? 'Conexão testada neste assistente' : 'Falta testar o acesso ao CRM';
      $('try-it-description').textContent = connectionVerified
        ? 'Depois de reiniciar seu aplicativo de IA, peça: “Liste até 5 contatos do meu InfiniteGear, sem alterar nada.” A conexão com o aplicativo é uma etapa separada.'
        : 'Use Testar conexão no passo 1 para conferir o acesso à API com estas chaves. Salvar a configuração e copiá-la para a IA não verifica o acesso ao CRM.';
    }
    updateProgress();
  }

  const clients = {
    claude: {
      filename: 'claude_desktop_config.json',
      instructions: [
        'No Claude Desktop, abra Configurações → Desenvolvedor → Editar configuração. A integração local precisa do aplicativo para computador.',
        'Abra o arquivo claude_desktop_config.json com um editor de texto. Copie a configuração abaixo para o arquivo e salve.',
        'Encerre o Claude Desktop por completo e abra novamente. Procure a conexão InfiniteGear nas ferramentas do aplicativo.',
      ],
    },
    cursor: {
      filename: '~/.cursor/mcp.json',
      instructions: [
        'No Cursor, abra Settings → Tools & MCP e escolha Add Custom MCP. Os nomes podem variar conforme a versão.',
        'Copie a configuração abaixo para o arquivo mcp.json que o Cursor abrir e salve.',
        'Volte à lista de ferramentas e ative infinitegear. Se necessário, reinicie o Cursor.',
      ],
    },
    vscode: {
      filename: '.vscode/mcp.json',
      instructions: [
        'No Visual Studio Code, abra uma pasta de trabalho. Dentro dela, crie a pasta .vscode e o arquivo mcp.json.',
        'Copie a configuração abaixo para .vscode/mcp.json e salve. É necessário um recurso de chat com suporte a MCP.',
        'Use o comando MCP: List Servers, selecione infinitegear e inicie o servidor. Aprove a conexão quando o aplicativo solicitar.',
      ],
    },
    generic: {
      filename: 'Configuração MCP · transporte stdio',
      instructions: [
        'Nas configurações do aplicativo, procure por MCP, Conectores ou Ferramentas.',
        'Adicione um servidor local com transporte stdio. Use command como programa e cada item de args como um argumento, ou cole o JSON se houver essa opção.',
        'Salve e reinicie o aplicativo. Ele precisa estar neste computador e oferecer suporte a servidores MCP locais.',
      ],
    },
  };

  function notice(id, message, kind = 'neutral') {
    const element = $(id);
    element.className = `notice notice-${kind}`;
    element.textContent = message;
    element.hidden = false;
  }

  function setBusy(value, action) {
    busy = value;
    $('test-button').disabled = value;
    $('save-button').disabled = value;
    for (const id of ['api-url', 'api-token', 'partner-token', 'allow-writes']) $(id).disabled = value;
    $('test-button').textContent = value && action === 'test' ? 'Verificando conexão…' : 'Testar conexão';
    $('save-button').textContent = value && action === 'save' ? 'Salvando…' : 'Salvar configuração  →';
    $('connection-form').setAttribute('aria-busy', String(value));
  }

  async function api(route, input) {
    const headers = { 'X-Setup-Token': setupToken || '' };
    const options = { headers, credentials: 'omit' };
    if (input !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.method = 'POST';
      options.body = JSON.stringify(input);
    }
    let response;
    try { response = await fetch(route, options); }
    catch { throw new Error('O assistente não está respondendo. Confira se o terminal continua aberto e tente novamente.'); }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir esta etapa.');
    return data;
  }

  function fields() {
    $('api-url').removeAttribute('aria-invalid');
    $('api-token').removeAttribute('aria-invalid');
    let url;
    try { url = new URL($('api-url').value.trim()); } catch { /* Message below. */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      $('advanced-settings').open = true;
      $('api-url').setAttribute('aria-invalid', 'true');
      $('api-url').focus();
      throw new Error('Informe o endereço HTTPS da API da sua conta, sem senha, parâmetros ou fragmentos.');
    }
    if (url.hostname === 'readme.io' || url.hostname.endsWith('.readme.io')) {
      $('advanced-settings').open = true;
      $('api-url').setAttribute('aria-invalid', 'true');
      $('api-url').focus();
      throw new Error('Esse link abre a documentação. Use https://api.crm.infinitegear.app ou o endereço de API indicado pelo administrador.');
    }
    if (!$('api-token').value.trim() && !hasSavedToken) {
      $('api-token').setAttribute('aria-invalid', 'true');
      $('api-token').focus();
      throw new Error('Cole sua chave de acesso à API para continuar.');
    }
    return {
      apiUrl: $('api-url').value.trim(),
      apiToken: $('api-token').value.trim(),
      partnerToken: $('partner-token').value.trim(),
      allowWrites: $('allow-writes').checked,
    };
  }

  function markSavedToken() {
    hasSavedToken = true;
    $('api-token').required = false;
    $('token-required').textContent = 'já salva';
    $('api-token').placeholder = 'Chave salva neste computador';
    $('api-token-help').textContent = 'Sua chave já está salva. Deixe este campo em branco para mantê-la ou cole uma nova chave para substituí-la.';
  }

  function showFile(configPath) {
    if (!configPath) return;
    $('config-path').textContent = configPath;
    $('local-file').hidden = false;
  }

  function renderClient() {
    const selected = $('client-select').value;
    const details = clients[selected];
    if (!clientConfigurations) return;
    $('client-instructions').replaceChildren(...details.instructions.map((instruction) => {
      const item = document.createElement('li');
      item.textContent = instruction;
      return item;
    }));
    $('config-filename').textContent = details.filename;
    $('client-config').textContent = JSON.stringify(clientConfigurations[selected], null, 2);
    $('copy-status').textContent = '';
    $('client-locked').hidden = saved;
    $('client-ready').hidden = !saved;
  }

  $('connection-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    try {
      const input = fields();
      const testedRevision = formRevision;
      connectionVerified = false;
      setBusy(true, 'test');
      notice('connection-status', 'Consultando a API com as credenciais informadas…');
      const result = await api('/api/test', input);
      connectionVerified = result.ok === true && testedRevision === formRevision;
      updateCatalog(result);
      notice('connection-status', result.message, result.ok ? 'success' : 'error');
    } catch (error) {
      connectionVerified = false;
      updateCatalog({ apiCatalogReady });
      notice('connection-status', error.message, 'error');
    }
    finally { setBusy(false); }
  });

  $('save-button').addEventListener('click', async () => {
    if (busy) return;
    try {
      const input = fields();
      setBusy(true, 'save');
      const result = await api('/api/save', input);
      saved = true;
      // Saving never establishes verification; only a prior unchanged successful test does.
      updateCatalog(result);
      markSavedToken();
      for (const id of ['api-token', 'partner-token']) {
        $(id).value = '';
        $(id).type = 'password';
        const button = document.querySelector(`[data-reveal="${id}"]`);
        button.textContent = 'Mostrar';
        button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-label', id === 'api-token' ? 'Mostrar chave de acesso' : 'Mostrar chave de parceiro');
      }
      showFile(result.configPath);
      const savedMessage = !apiCatalogReady
        ? 'Chaves salvas neste computador. Você pode preparar o aplicativo no passo 3, mas o catálogo de operações precisa estar disponível para acessar o CRM.'
        : connectionVerified
          ? 'Configuração salva. O teste de conexão destes dados passou nesta sessão. Continue no passo 3 para configurar seu aplicativo de IA.'
          : 'Chaves salvas neste computador. A conexão com o CRM ainda não foi verificada: use Testar conexão no passo 1. Você também pode preparar o aplicativo no passo 3.';
      notice('save-status', savedMessage, apiCatalogReady && connectionVerified ? 'success' : 'neutral');
      clientConfigurations = await api('/api/client-config');
      renderClient();
    } catch (error) { notice('save-status', error.message, 'error'); }
    finally { setBusy(false); }
  });

  document.querySelectorAll('[data-reveal]').forEach((button) => {
    button.addEventListener('click', () => {
      const field = $(button.dataset.reveal);
      const visible = field.type === 'password';
      field.type = visible ? 'text' : 'password';
      button.textContent = visible ? 'Ocultar' : 'Mostrar';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', `${visible ? 'Ocultar' : 'Mostrar'} ${field.id === 'api-token' ? 'chave de acesso' : 'chave de parceiro'}`);
    });
  });

  $('client-select').addEventListener('change', renderClient);
  $('copy-button').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('client-config').textContent);
      $('copy-status').textContent = 'Configuração copiada. Agora cole no arquivo indicado acima.';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($('client-config'));
      selection.removeAllRanges();
      selection.addRange(range);
      $('copy-status').textContent = 'O navegador bloqueou a cópia automática. O texto foi selecionado: use Ctrl+C ou ⌘C para copiar.';
    }
  });

  ['api-url', 'api-token', 'partner-token', 'allow-writes'].forEach((id) => {
    $(id).addEventListener('input', () => {
      formRevision += 1;
      connectionVerified = false;
      $('connection-status').hidden = true;
      if (saved) {
        saved = false;
        renderClient();
        notice('save-status', 'Você mudou a configuração. Salve novamente para usar esses dados.', 'neutral');
      }
      updateCatalog({ apiCatalogReady });
    });
  });

  async function initialize() {
    if (!setupToken) {
      notice('session-notice', 'Para começar, abra em uma nova aba o endereço completo mostrado no terminal, incluindo a parte depois de #. Faça isso também se você atualizou esta página.', 'error');
      $('test-button').disabled = true;
      $('save-button').disabled = true;
      return;
    }
    try {
      const status = await api('/api/status');
      $('api-url').value = status.apiUrl || defaultApiUrl;
      $('advanced-settings').open = Boolean(status.apiUrl && status.apiUrl !== defaultApiUrl) || status.hasPartnerToken === true;
      $('allow-writes').checked = status.allowWrites;
      if (status.hasToken) markSavedToken();
      if (status.hasPartnerToken) $('partner-token').placeholder = 'Chave de parceiro já salva';
      saved = status.configured;
      connectionVerified = false;
      updateCatalog(status);
      if (saved) {
        showFile(status.configPath);
        clientConfigurations = await api('/api/client-config');
        renderClient();
        notice('save-status', 'Há chaves salvas neste computador. A conexão com o CRM ainda não foi testada nesta sessão.', 'neutral');
      }
    } catch (error) {
      notice('session-notice', error.message, 'error');
      $('test-button').disabled = true;
      $('save-button').disabled = true;
    }
  }
  initialize();
})();
