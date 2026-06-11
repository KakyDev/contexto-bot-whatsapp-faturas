# 01 — Visão geral do projeto

## Objetivo
Criar um bot de automação via WhatsApp Web para coletar/baixar faturas da CEEE Grupo Equatorial de forma automatizada, reduzindo o trabalho manual do time de faturamento.

O bot deve ler uma lista de Unidades Consumidoras (UC), CPF ou CNPJ a partir de uma planilha Excel/CSV, iniciar uma conversa no WhatsApp com o atendimento da CEEE/Equatorial, seguir o fluxo do bot oficial, selecionar a fatura referente ao mês/ano desejado, baixar o PDF e registrar o resultado do processamento.

## Contexto operacional
Hoje o time entra manualmente no WhatsApp, informa a UC ou CPF/CNPJ, confirma dados, seleciona segunda via de fatura, escolhe a referência do mês/ano e baixa o PDF.

O fluxo será automatizado usando WhatsApp Web em um computador dedicado da empresa.

## Premissas
- O WhatsApp usado será um número da empresa, logado no WhatsApp Web.
- O bot conversará com o número oficial da CEEE Grupo Equatorial.
- O bot deverá processar uma UC por vez.
- Deve haver delay mínimo de 5 segundos entre mensagens/interações para evitar confusão entre os dois bots.
- O mês/ano de referência será informado como parâmetro por linha da planilha, exemplo: `04/2026`.
- O bot deve salvar o PDF baixado localmente.
- O bot deve registrar sucesso, erro, motivo do erro, horário e caminho do arquivo.

## Fora do escopo do MVP
- Dashboard web completo.
- Integração com API oficial do WhatsApp Business.
- Processamento paralelo de várias UCs ao mesmo tempo.
- Interpretação avançada de documentos PDF.
- Envio automático dos PDFs por e-mail.
- Integração com ERP ou banco de dados corporativo.

## Stack sugerida
- Node.js + TypeScript
- Playwright para controlar o WhatsApp Web
- XLSX para ler Excel
- dotenv para configurações
- pino ou winston para logs
- zod para validação de dados
- fs/path para salvar PDFs

## Resultado esperado
Ao final da execução, cada linha da planilha deve ter um status:

- `success`: PDF baixado com sucesso.
- `not_found`: fatura do mês/ano não encontrada.
- `invalid_data`: UC/CPF/CNPJ inválido ou não localizado.
- `authentication_required`: WhatsApp Web precisa de login.
- `conversation_error`: fluxo inesperado no bot da CEEE.
- `download_error`: PDF não foi baixado.
- `timeout`: bot não respondeu dentro do tempo limite.

