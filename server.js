import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// Precisamos do body bruto para validar a assinatura do webhook
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));

// Banco de dados (arquivo local)
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "desafio.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    package_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    coins INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    cobranca_id TEXT UNIQUE,
    valor_pix INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS balances (
    player_id TEXT PRIMARY KEY,
    coins INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS grants (
    event_id TEXT PRIMARY KEY,
    cobranca_id TEXT NOT NULL,
    order_id TEXT NOT NULL UNIQUE,
    player_id TEXT NOT NULL,
    coins INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Pacotes de moedas (valores em centavos)
// Você pode alterar depois
const PACKAGES = {
  moedas_100:  { amountCents: 490,  coins: 100,  label: "100 moedas" },
  moedas_500:  { amountCents: 1990, coins: 500,  label: "500 moedas" },
  moedas_1200: { amountCents: 3990, coins: 1200, label: "1.200 moedas" },
  moedas_3000: { amountCents: 8990, coins: 3000, label: "3.000 moedas" }
};

const SYNCPIX_BASE = "https://teste.htmlcode.com.br/api/v1";

function requireConfig(res) {
  if (!process.env.SYNCPIX_API_KEY || !process.env.SYNCPIX_WEBHOOK_SECRET || !process.env.PUBLIC_BASE_URL) {
    res.status(503).json({ error: "Servidor ainda não configurado. Faltam variáveis de ambiente." });
    return false;
  }
  return true;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "Desafio da Mira - SyncPIX", ambiente: "teste" });
});

// Lista de pacotes (o jogo busca daqui)
app.get("/api/packages", (_req, res) => {
  const list = Object.entries(PACKAGES).map(([id, p]) => ({
    id,
    label: p.label,
    coins: p.coins,
    price: (p.amountCents / 100).toFixed(2).replace(".", ",")
  }));
  res.json(list);
});

// Cria cobrança Pix
app.post("/api/create-pix", async (req, res) => {
  if (!requireConfig(res)) return;

  const { playerId, packageId } = req.body || {};

  if (typeof playerId !== "string" || playerId.length < 8 || playerId.length > 120) {
    return res.status(400).json({ error: "Identificador de jogador inválido." });
  }

  const pack = PACKAGES[packageId];
  if (!pack) return res.status(400).json({ error: "Pacote inválido." });

  const orderId = randomUUID();

  db.prepare(`
    INSERT INTO orders (id, player_id, package_id, amount_cents, coins)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, playerId, packageId, pack.amountCents, pack.coins);

  try {
    const response = await fetch(`${SYNCPIX_BASE}/cobrancas`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SYNCPIX_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": orderId
      },
      body: JSON.stringify({
        valor: pack.amountCents,
        descricao: `Desafio da Mira - ${pack.label}`,
        referencia_externa: orderId,
        expiracao: 1800, // 30 minutos
        metadata: {
          player_id: playerId,
          package_id: packageId
        }
      })
    });

    const data = await response.json();

    if (response.status !== 201) {
      console.error("SyncPIX erro ao criar cobrança:", data);
      db.prepare("UPDATE orders SET status='error' WHERE id=?").run(orderId);
      return res.status(502).json({
        error: data?.erro?.mensagem || "Não foi possível gerar o Pix. Tente novamente."
      });
    }

    // Guarda o ID da cobrança e o valor final (pode ter centavos exclusivos)
    db.prepare("UPDATE orders SET cobranca_id=?, valor_pix=?, status='pending' WHERE id=?")
      .run(data.id, data.valor, orderId);

    return res.json({
      orderId,
      cobrancaId: data.id,
      status: data.status,
      valor: data.valor,
      copiaECola: data.pix?.copia_e_cola || null,
      qrCodeBase64: data.pix?.qr_code_base64 || null,
      linkPagamento: data.link_pagamento || null,
      expiraEm: data.pix?.expira_em || null
    });
  } catch (err) {
    console.error("Erro ao criar cobrança:", err);
    db.prepare("UPDATE orders SET status='error' WHERE id=?").run(orderId);
    return res.status(500).json({ error: "Erro interno ao gerar Pix." });
  }
});

// Valida assinatura do webhook SyncPIX
function validarAssinatura(req) {
  const secret = process.env.SYNCPIX_WEBHOOK_SECRET;
  const ts = req.get("X-Webhook-Timestamp") || "";
  const assinatura = req.get("X-Webhook-Assinatura") || "";
  const corpo = req.rawBody ? req.rawBody.toString("utf8") : "";

  if (!secret || !ts || !assinatura || !corpo) return false;
  if (!/^\d+$/.test(ts)) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // 5 minutos

  const esperada = "v1=" + crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${corpo}`)
    .digest("hex");

  try {
    const a = Buffer.from(esperada);
    const b = Buffer.from(assinatura);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Credita moedas de forma segura (só uma vez)
function creditarPedido(evento) {
  if (evento.tipo !== "cobranca.paga") return;

  const cobranca = evento.dados;
  if (!cobranca || cobranca.status !== "pago") return;

  const orderId = String(cobranca.referencia_externa || "");
  if (!orderId) return;

  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
  if (!order) return;

  // Confere o valor (importante por causa dos centavos exclusivos)
  if (order.valor_pix && Number(cobranca.valor) !== Number(order.valor_pix)) {
    console.warn("Valor diferente do esperado", { orderId, esperado: order.valor_pix, recebido: cobranca.valor });
    return;
  }

  const grant = db.transaction(() => {
    // Já creditou este evento ou este pedido?
    const jaExiste = db.prepare(
      "SELECT event_id FROM grants WHERE event_id=? OR order_id=?"
    ).get(evento.id, orderId);

    if (jaExiste) return;

    // Credita as moedas
    db.prepare(`
      INSERT INTO balances (player_id, coins) VALUES (?, ?)
      ON CONFLICT(player_id) DO UPDATE SET coins = coins + excluded.coins
    `).run(order.player_id, order.coins);

    // Registra a concessão (impede duplicar)
    db.prepare(`
      INSERT INTO grants (event_id, cobranca_id, order_id, player_id, coins)
      VALUES (?, ?, ?, ?, ?)
    `).run(evento.id, cobranca.id, orderId, order.player_id, order.coins);

    // Atualiza status do pedido
    db.prepare("UPDATE orders SET status='pago', cobranca_id=? WHERE id=?")
      .run(cobranca.id, orderId);
  });

  grant();
  console.log(`Moedas creditadas: ${order.coins} para jogador ${order.player_id}`);
}

// Webhook do SyncPIX
app.post("/api/webhook", (req, res) => {
  if (!requireConfig(res)) return;

  if (!validarAssinatura(req)) {
    console.warn("Webhook com assinatura inválida");
    return res.sendStatus(401);
  }

  try {
    const evento = req.body;
    if (evento && evento.id) {
      creditarPedido(evento);
    }
    // Sempre responde 200 rápido
    return res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err);
    return res.sendStatus(500);
  }
});

// Consulta saldo do jogador
app.get("/api/balance/:playerId", (req, res) => {
  const playerId = String(req.params.playerId || "");
  if (playerId.length < 8 || playerId.length > 120) {
    return res.status(400).json({ error: "Jogador inválido." });
  }
  const row = db.prepare("SELECT coins FROM balances WHERE player_id=?").get(playerId);
  res.json({ coins: row?.coins || 0 });
});

// Consulta status de um pedido (útil para o jogo ficar verificando)
app.get("/api/order/:orderId", (req, res) => {
  const orderId = String(req.params.orderId || "");
  const order = db.prepare("SELECT id, status, coins, player_id FROM orders WHERE id=?").get(orderId);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  res.json({
    orderId: order.id,
    status: order.status,
    coins: order.coins
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Desafio da Mira (SyncPIX) rodando na porta ${port}`);
});
