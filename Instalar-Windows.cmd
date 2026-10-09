@echo off
setlocal
cd /d "%~dp0"
title Configurar InfiniteGear MCP
echo.
echo  InfiniteGear MCP - instalacao guiada
echo  ------------------------------------
echo.
where node >nul 2>&1
if errorlevel 1 goto missing_node
node -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)"
if errorlevel 1 goto missing_node
where npm >nul 2>&1
if errorlevel 1 goto missing_node
echo  [1/2] Preparando os arquivos. Aguarde...
call npm ci --omit=dev --ignore-scripts --no-fund --cache .npm-cache
if errorlevel 1 goto failed
echo.
echo  [2/2] Abrindo o assistente no seu navegador...
echo  Mantenha esta janela aberta durante a configuracao.
node src\cli.js setup
if errorlevel 1 goto failed
goto end
:missing_node
echo  Instale o Node.js LTS (22 ou superior) em https://nodejs.org/
echo  Depois, feche esta janela e abra este arquivo novamente.
goto end
:failed
echo.
echo  Nao foi possivel concluir. Leia a mensagem acima.
echo  Veja docs\instalacao-local.md para ajuda.
:end
echo.
pause
endlocal
