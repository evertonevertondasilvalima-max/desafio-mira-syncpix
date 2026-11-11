# Desafio da Mira 3D – Servidor SyncPIX

Servidor simples para gerar cobranças Pix pelo SyncPIX e creditar moedas automaticamente após o pagamento.

## Variáveis de ambiente (Render)

- `SYNCPIX_API_KEY` → chave sk_test_ gerada no painel
- `SYNCPIX_WEBHOOK_SECRET` → Segredo padrão do painel
- `PUBLIC_BASE_URL` → URL do seu serviço no Render (ex: https://desafio-da-mira.onrender.com)
- `ALLOWED_ORIGIN` → * (ou o domínio do jogo)

## Rotas

- GET  /health
- GET  /api/packages
- POST /api/create-pix   { playerId, packageId }
- POST /api/webhook
- GET  /api/balance/:playerId
- GET  /api/order/:orderId

## Deploy no Render

1. Crie um novo Web Service
2. Conecte o repositório ou faça upload do ZIP
3. Runtime: Node
4. Build Command: npm install
5. Start Command: npm start
6. Adicione as variáveis de ambiente
7. Deploy
