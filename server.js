'use strict';
/**
 * Desafio da Mira 3D - Servidor SyncPIX
 * Sem dependências externas (precisa de Node 18 ou mais novo).
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---------- Configuração (vem das variáveis de ambiente do Render) ----------
const PORT = process.env.PORT || 3000;
const API_URL = (process.env.SYNCPIX_API_URL || 'https://teste.htmlcode.com.br/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.SYNCPIX_API_KEY || '';
const WEBHOOK_SECRET = process.env.SYNCPIX_WEBHOOK_SECRET || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Pacotes de moedas. O preço fica AQUI no servidor (em centavos), nunca no jogo.
const PACKAGES = [
  { id: 'p100', nome: '100 moedas', moedas: 100, preco: 500 },
  { id: 'p550', nome: '550 moedas', moedas: 550, preco: 2500 },
  { id: 'p1200', nome: '1200 moedas', moedas: 1200, preco: 5000 },
  { id: 'p2600', nome: '2600 moedas', moedas: 2600, preco: 10000 },
];

if (!API_KEY) console.warn('AVISO: SYNCPIX_API_KEY não definida.');
if (!WEBHOOK_SECRET) console.warn('AVISO: SYNCPIX_WEBHOOK_SECRET não definida (webhooks serão recusados).');

// ---------- "Banco de dados" em arquivo JSON ----------
// ATENÇÃO: no Render grátis o disco é apagado a cada deploy/reinício.
// Serve para TESTE. Para produção, use disco persistente ou um banco de dados.
let db = { players: {}, orders: {}, events: {} };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) {
  console.error('Não consegui ler o banco:', e.message);
}
const limite30d = Date.now() - 30 * 24 * 3600 * 1000;
for (const [id, t] of Object.entries(db.events)) if (t < limite30d) delete db.events[id];

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function getPlayer(id) {
  if (!db.players[id]) db.players[id] = { coins: 0, progress: {}, createdAt: Date.now() };
  return db.players[id];
}

// ---------- Utilidades ----------
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

function send(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('corpo grande demais'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 20000) {
  const raw = await readBody(req, limit);
  try {
    const obj = JSON.parse(raw.toString('utf8') || '{}');
    if (obj === null || typeof obj !== 'object') throw new Error();
    return obj;
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, l] of hits) if (!l.some((t) => now - t < 3600000)) hits.delete(k);
}, 600000).unref();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
}

// ---------- SyncPIX ----------
async function syncpix(method, endpoint, body, idemKey) {
  const headers = { Authorization: `Bearer ${API_KEY}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  const r = await fetch(API_URL + endpoint, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let data = null;
  try { data = await r.json(); } catch { /* sem corpo */ }
  return { status: r.status, data };
}

function validSignature(raw, ts, sig) {
  if (!WEBHOOK_SECRET || !/^\d+$/.test(ts || '')) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = Buffer.from(
    'v1=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${raw.toString('utf8')}`).digest('hex')
  );
  const got = Buffer.from(sig || '');
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// ---------- Crédito das moedas (um único ponto, idempotente) ----------
function creditOrder(order) {
  // Tudo síncrono: não há como duas execuções creditarem a mesma compra.
  if (order.status === 'pago') return false;
  order.status = 'pago';
  order.pagoEm = Date.now();
  getPlayer(order.playerId).coins += order.moedas;
  save();
  console.log(`Pago: pedido ${order.id} -> +${order.moedas} moedas para ${order.playerId}`);
  return true;
}

// Confirma NA API do SyncPIX (com a chave secreta) antes de liberar moedas.
async function confirmWithApi(order) {
  const r = await syncpix('GET', `/cobrancas/${encodeURIComponent(order.chargeId)}`);
  if (r.status !== 200 || !r.data) throw new Error(`consulta falhou (${r.status})`);
  const c = r.data;
  const igual = c.id === order.chargeId && c.referencia_externa === order.id && Number(c.valor) === order.valorPix;
  if (!igual) return { ok: false, status: 'divergente' };
  return { ok: c.status === 'pago', status: c.status };
}

async function reconcile(order) {
  const res = await confirmWithApi(order);
  if (res.ok) creditOrder(order);
  else if ((res.status === 'expirado' || res.status === 'cancelado') && order.status === 'pendente') {
    order.status = res.status;
    save();
  }
}

// ---------- Rotas ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const route = `${req.method} /${parts[0] || ''}${parts[1] ? '/' + parts[1] : ''}`;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (route === 'GET /' || route === 'GET /health') {
    return send(res, 200, {
      ok: true,
      ambiente: API_KEY.startsWith('sk_live_') ? 'producao' : 'teste',
      configurado: Boolean(API_KEY && WEBHOOK_SECRET),
    });
  }

  if (route === 'GET /api/packages') {
    return send(res, 200, PACKAGES.map((p) => ({ id: p.id, nome: p.nome, moedas: p.moedas, preco: p.preco })));
  }

  if (route === 'POST /api/create-pix') {
    if (limited('ip:' + clientIp(req), 20, 10 * 60 * 1000)) return send(res, 429, { erro: 'Muitas tentativas. Aguarde um pouco.' });
    const { playerId, packageId } = await readJson(req);
    const pkg = PACKAGES.find((p) => p.id === packageId);
    if (!ID_RE.test(String(playerId || '')) || !pkg) return send(res, 400, { erro: 'Dados inválidos.' });

    const pendentes = Object.values(db.orders).filter(
      (o) => o.playerId === playerId && o.status === 'pendente' && Date.now() - o.createdAt < 3600000
    ).length;
    if (pendentes >= 5) return send(res, 429, { erro: 'Você tem Pix pendentes demais. Pague ou aguarde expirar.' });

    const orderId = crypto.randomUUID();
    const r = await syncpix(
      'POST',
      '/cobrancas',
      {
        valor: pkg.preco,
        descricao: `Desafio da Mira 3D - ${pkg.nome}`.slice(0, 140),
        referencia_externa: orderId,
        expiracao: 1800,
        metadata: { playerId, packageId: pkg.id },
      },
      `order-${orderId}`
    );
    if (r.status !== 201 || !r.data || !r.data.pix) {
      console.error('Erro ao criar cobrança:', r.status, JSON.stringify(r.data));
      return send(res, 502, { erro: 'Não foi possível gerar o Pix agora. Tente de novo.' });
    }
    const c = r.data;
    db.orders[orderId] = {
      id: orderId,
      playerId,
      packageId: pkg.id,
      moedas: pkg.moedas,
      valorBase: pkg.preco,
      valorPix: Number(c.valor), // pode ter centavos exclusivos a mais
      chargeId: c.id,
      status: 'pendente',
      createdAt: Date.now(),
      lastCheck: 0,
    };
    getPlayer(playerId);
    save();
    return send(res, 201, {
      orderId,
      valor: Number(c.valor),
      copiaECola: c.pix.copia_e_cola,
      qrCode: c.pix.qr_code_base64,
      expiraEm: c.pix.expira_em,
      linkPagamento: c.link_pagamento,
    });
  }

  if (route === 'POST /api/webhook') {
    const raw = await readBody(req, 100000);
    const ok = validSignature(raw, req.headers['x-webhook-timestamp'], req.headers['x-webhook-assinatura']);
    if (!ok) {
      console.warn('Webhook recusado: assinatura inválida.');
      return send(res, 401, { erro: 'assinatura inválida' });
    }
    let evento;
    try { evento = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { erro: 'JSON inválido' }); }
    if (!evento || !evento.id) return send(res, 400, { erro: 'evento inválido' });
    if (db.events[evento.id]) return send(res, 200, { ok: true, repetido: true });

    if (evento.tipo === 'cobranca.paga' && evento.dados) {
      const order = db.orders[evento.dados.referencia_externa];
      if (!order) {
        console.warn('Pagamento sem pedido conhecido:', evento.dados.referencia_externa);
      } else if (order.status !== 'pago') {
        // se a consulta falhar, o erro vira 500 e o SyncPIX tenta de novo depois
        const conf = await confirmWithApi(order);
        if (conf.ok) creditOrder(order);
        else console.warn('Webhook "pago" mas a API não confirmou:', order.id, conf.status);
      }
    } else if ((evento.tipo === 'cobranca.expirada' || evento.tipo === 'cobranca.cancelada') && evento.dados) {
      const order = db.orders[evento.dados.referencia_externa];
      if (order && order.status === 'pendente') {
        order.status = evento.tipo === 'cobranca.expirada' ? 'expirado' : 'cancelado';
        save();
      }
    }
    db.events[evento.id] = Date.now();
    save();
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/balance') {
    const id = parts[2];
    if (!ID_RE.test(id || '')) return send(res, 400, { erro: 'Jogador inválido.' });
    return send(res, 200, { coins: getPlayer(id).coins });
  }

  if (route === 'GET /api/order') {
    const order = db.orders[parts[2] || ''];
    if (!order) return send(res, 404, { erro: 'Pedido não encontrado.' });
    // Plano B caso o webhook demore: confere na API, no máximo a cada 8 segundos.
    if (order.status === 'pendente' && Date.now() - order.lastCheck > 8000) {
      order.lastCheck = Date.now();
      try { await reconcile(order); } catch (e) { console.warn('Reconciliação falhou:', e.message); }
    }
    return send(res, 200, { status: order.status, moedas: order.moedas, coins: getPlayer(order.playerId).coins });
  }

  if (route === 'POST /api/spend') {
    const { playerId, amount } = await readJson(req);
    const n = Number(amount);
    if (!ID_RE.test(String(playerId || '')) || !Number.isInteger(n) || n < 1 || n > 1000000) {
      return send(res, 400, { erro: 'Dados inválidos.' });
    }
    const p = getPlayer(playerId);
    if (p.coins < n) return send(res, 409, { erro: 'Moedas insuficientes.', coins: p.coins });
    p.coins -= n;
    save();
    return send(res, 200, { coins: p.coins });
  }

  if (route === 'GET /api/progress') {
    if (!ID_RE.test(parts[2] || '')) return send(res, 400, { erro: 'Jogador inválido.' });
    return send(res, 200, { progress: getPlayer(parts[2]).progress });
  }

  if (route === 'POST /api/progress') {
    const { playerId, progress } = await readJson(req, 20000);
    if (!ID_RE.test(String(playerId || '')) || typeof progress !== 'object' || progress === null) {
      return send(res, 400, { erro: 'Dados inválidos.' });
    }
    getPlayer(playerId).progress = progress; // moedas NÃO ficam aqui, só no saldo do servidor
    save();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { erro: 'Rota não encontrada.' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('Erro:', e.message);
      if (!res.headersSent) send(res, e.status || 500, { erro: e.status ? e.message : 'Erro interno.' });
    });
  })
  .listen(PORT, () => console.log(`Servidor rodando na porta ${PORT} (${API_URL})`));
