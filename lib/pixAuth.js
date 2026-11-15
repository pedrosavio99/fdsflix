'use strict';

/**
 * Teste de "permissão por pagamento Pix" (só a tela do administrador).
 *
 * Fluxo: o aparelho pede uma cobrança -> mostramos o QR/copia-e-cola do Pix estático do dono -> quem paga gera um e-mail
 * do Nubank na caixa do Gmail -> o Apps Script avisa o nó do Wasmer (pixkit/) -> aqui, enquanto a tela está aberta,
 * consultamos o nó e casamos o aviso com a cobrança pendente (mesmo valor, dentro da janela de tempo, e-mail ainda não usado).
 * Casou: a cobrança vira "paid" e o aparelho ganha acesso por 10 min.
 *
 * O e-mail do Nubank NÃO traz pagador nem txid; por isso o casamento é valor + tempo + Message-ID único (primeiro a pedir,
 * primeiro a ser atendido). Serve para TESTAR o fluxo; para dinheiro de verdade o certo é um provedor com webhook.
 *
 * Estado: Supabase (tabelas de supabase/pix-schema.sql), com memória como reserva se as tabelas ainda não existem.
 * A chave do nó é derivada da chave secreta do Supabase (privada, estável, sem variável nova no Render).
 */

const crypto = require('crypto');

const ACCESS_MS = 10 * 60 * 1000;     // quanto dura o acesso liberado
const VALID_MS = 15 * 60 * 1000;      // validade da cobrança
const GRACE_MS = 2 * 60 * 1000;       // tolerância depois de vencida (o e-mail pode atrasar um pouco)
const EARLY_MS = 30 * 1000;           // e-mail com horário até 30 s ANTES da cobrança ainda vale (relógios diferentes)
const POLL_MIN_MS = 3000;
const MAX_CHARGES = 200;

/* ------------------------------ código Pix (EMV) ------------------------------ */

function crc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id, value) {
  const v = String(value);
  return `${id}${String(v.length).padStart(2, '0')}${v}`;
}

/** Monta o copia-e-cola estático (sem a tag 01, como o Nubank gera). */
function buildPayload({ key, name, city, txid, amountCents }) {
  const body = [
    tlv('00', '01'),
    tlv('26', tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', key)),
    tlv('52', '0000'),
    tlv('53', '986'),
    tlv('54', (amountCents / 100).toFixed(2)),
    tlv('58', 'BR'),
    tlv('59', name),
    tlv('60', city),
    tlv('62', tlv('05', txid || '***'))
  ].join('');
  const head = `${body}6304`;
  return head + crc16(head);
}

function readTlv(text) {
  const out = {};
  let i = 0;
  while (i < text.length) {
    const id = text.slice(i, i + 2);
    const len = Number(text.slice(i + 2, i + 4));
    if (!/^\d\d$/.test(id) || !Number.isInteger(len) || i + 4 + len > text.length) throw new Error('código Pix malformado');
    out[id] = text.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

/** Lê um copia-e-cola (confere o CRC). Devolve os campos que usamos para gerar as cobranças. */
function parsePayload(code) {
  const text = String(code || '').replace(/[\r\n\t]+/g, '').trim(); // espaços ficam: fazem parte do nome e da cidade
  if (text.length < 40 || !text.startsWith('000201')) throw new Error('Isso não parece um código Pix copia-e-cola.');
  if (crc16(text.slice(0, -4)) !== text.slice(-4).toUpperCase()) throw new Error('O código Pix está com o CRC errado (copiou inteiro?).');
  const top = readTlv(text.slice(0, -8));
  const account = readTlv(top['26'] || '');
  if (!/^br\.gov\.bcb\.pix$/i.test(account['00'] || '') || !account['01']) throw new Error('Não achei a chave Pix no código.');
  const extra = top['62'] ? readTlv(top['62']) : {};
  const amount = top['54'] ? Math.round(Number(top['54']) * 100) : null;
  return {
    key: account['01'],
    name: top['59'] || '',
    city: top['60'] || '',
    txid: extra['05'] || '***',
    amountCents: Number.isFinite(amount) && amount > 0 ? amount : null
  };
}

/* ------------------------------ casamento e-mail <-> cobrança ------------------------------ */

/**
 * `pending` (ordenadas por criação) e `events` (do nó). Cada e-mail atende no máximo UMA cobrança, a mais antiga que
 * combine em valor e janela; e-mail cujo Message-ID já foi usado nunca conta de novo.
 */
function matchEvents(pending, events, usedIds) {
  const taken = new Set();
  const out = [];
  for (const ev of [...events].sort((a, b) => a.at - b.at)) {
    if (usedIds.has(ev.id)) continue;
    const charge = pending.find((c) => !taken.has(c.id) && c.amountCents === ev.amountCents &&
      ev.at >= c.createdAt - EARLY_MS && ev.at <= c.expiresAt + GRACE_MS);
    if (!charge) continue;
    taken.add(charge.id);
    out.push({ charge, event: ev });
  }
  return out;
}

/* ------------------------------ estado ------------------------------ */

/** Chave compartilhada com o nó do Wasmer: derivada da chave secreta do Supabase (nunca vai ao navegador). */
function deriveMailSecret(env = process.env) {
  const base = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base) return '';
  return crypto.createHmac('sha256', base).update('fdsflix-pix-mail-v1').digest('hex').slice(0, 48);
}

async function fetchMicroEvents({ url, secret, since }) {
  const res = await fetch(`${url}/pix/events?since=${Math.max(0, Math.floor(since))}`, {
    headers: { 'x-pix-secret': secret },
    signal: AbortSignal.timeout(8000)
  });
  if (res.status === 401) throw new Error('o nó recusou a chave (baixe o kit de novo)');
  if (!res.ok) throw new Error(`o nó respondeu HTTP ${res.status}`);
  return res.json();
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const ms = (value) => (value ? Date.parse(value) : 0);

function toRow(c) {
  return {
    id: c.id, device_id: c.deviceId, device: c.device, visitor: c.visitor, amount_cents: c.amountCents, status: c.status,
    created_at: iso(c.createdAt), expires_at: iso(c.expiresAt), paid_at: iso(c.paidAt), event_at: iso(c.eventAt),
    mail_id: c.mailId || null, granted_until: iso(c.grantedUntil), updated_at: iso(Date.now())
  };
}

function fromRow(r) {
  return {
    id: r.id, deviceId: r.device_id, device: r.device || '', visitor: r.visitor || '', amountCents: r.amount_cents,
    status: r.status, createdAt: ms(r.created_at), expiresAt: ms(r.expires_at), paidAt: ms(r.paid_at), eventAt: ms(r.event_at),
    mailId: r.mail_id || '', grantedUntil: ms(r.granted_until)
  };
}

function createPix(deps = {}) {
  const now = deps.now || Date.now;
  const db = deps.db || require('./usageStore');
  const getEvents = deps.fetchEvents || fetchMicroEvents;
  const secret = deps.secret !== undefined ? deps.secret : deriveMailSecret();

  const state = {
    loaded: false, loading: null, nextLoadAt: 0,
    charges: new Map(),
    settings: { microUrl: '', pix: null },
    persist: { enabled: false, tablesMissing: false, lastError: '' },
    micro: { lastOkAt: 0, lastError: '', lastPushAt: 0, rejected: [] },
    lastFetchAt: 0, refreshing: null
  };

  const quiet = { quiet: true };

  async function load() {
    state.persist.enabled = Boolean(db.enabled());
    if (!state.persist.enabled) { state.loaded = true; return; }
    try {
      const settings = await db.call('GET', '/pix_settings?select=k,v', undefined, undefined, quiet);
      for (const row of settings || []) {
        if (row.k === 'micro_url' && row.v && row.v.url) state.settings.microUrl = String(row.v.url);
        if (row.k === 'pix' && row.v && row.v.key) state.settings.pix = row.v;
      }
      const rows = await db.call('GET', `/pix_charges?select=*&order=created_at.desc&limit=${MAX_CHARGES}`, undefined, undefined, quiet);
      for (const row of rows || []) state.charges.set(row.id, fromRow(row));
      state.persist.tablesMissing = false;
      state.persist.lastError = '';
      state.loaded = true;
    } catch (err) {
      state.persist.tablesMissing = Boolean(err.tablesMissing);
      state.persist.lastError = err.message;
      state.loaded = true; // segue só na memória; tenta carregar de novo mais tarde se não foi "tabela faltando"
      if (!err.tablesMissing) { state.loaded = false; state.nextLoadAt = now() + 30000; }
    }
  }

  async function ready() {
    if (state.loaded) return;
    if (now() < state.nextLoadAt) return;
    if (!state.loading) state.loading = load().finally(() => { state.loading = null; });
    await state.loading;
  }

  async function write(path, body, headers) {
    if (!state.persist.enabled || state.persist.tablesMissing) return;
    try {
      await db.call('POST', path, body, { Prefer: 'resolution=merge-duplicates,return=minimal', ...(headers || {}) }, quiet);
      state.persist.lastError = '';
    } catch (err) {
      state.persist.lastError = err.message;
      if (err.tablesMissing) state.persist.tablesMissing = true;
    }
  }

  const saveCharge = (c) => write('/pix_charges?on_conflict=id', toRow(c));
  const saveSetting = (k, v) => write('/pix_settings?on_conflict=k', { k, v, updated_at: iso(now()) });

  function trim() {
    if (state.charges.size <= MAX_CHARGES) return;
    const sorted = [...state.charges.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const c of sorted.slice(0, state.charges.size - MAX_CHARGES)) state.charges.delete(c.id);
  }

  function view(c) {
    return {
      id: c.id, status: c.status, amountCents: c.amountCents, device: c.device, visitor: c.visitor,
      createdAt: c.createdAt, expiresAt: c.expiresAt, paidAt: c.paidAt || null, grantedUntil: c.grantedUntil || null
    };
  }

  function access(deviceId) {
    let until = 0;
    for (const c of state.charges.values()) if (c.deviceId === deviceId && c.status === 'paid' && c.grantedUntil > until) until = c.grantedUntil;
    return until > now() ? { until, remainingMs: until - now() } : null;
  }

  function codeFor(c) {
    const p = state.settings.pix;
    return buildPayload({ key: p.key, name: p.name, city: p.city, txid: p.txid, amountCents: c.amountCents });
  }

  function publicSettings() {
    const p = state.settings.pix;
    return {
      microUrl: state.settings.microUrl,
      pix: p ? { keyHint: `${String(p.key).slice(0, 8)}…`, name: p.name, city: p.city, amountCents: p.amountCents } : null,
      kitReady: Boolean(secret)
    };
  }

  async function saveSettings({ microUrl, pixCode } = {}) {
    await ready();
    if (microUrl !== undefined && microUrl !== null && String(microUrl).trim() !== '') {
      const url = String(microUrl).trim().replace(/\/+$/, '');
      if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:|\/|$))[^\s'"\\<>]+$/i.test(url)) throw new Error('A URL do nó precisa começar com https://');
      state.settings.microUrl = url;
      await saveSetting('micro_url', { url });
    }
    if (pixCode !== undefined && pixCode !== null && String(pixCode).trim() !== '') {
      const parsed = parsePayload(pixCode);
      const pix = { ...parsed, amountCents: parsed.amountCents || 1 };
      state.settings.pix = pix;
      await saveSetting('pix', pix);
    }
    return publicSettings();
  }

  async function createCharge({ deviceId, device, visitor } = {}) {
    await ready();
    if (!/^[\w-]{8,64}$/.test(String(deviceId || ''))) throw new Error('Aparelho sem identificação.');
    if (!state.settings.pix) throw new Error('Cole antes o seu código Pix copia-e-cola e salve.');
    const t = now();
    for (const c of state.charges.values()) {
      if (c.deviceId === deviceId && c.status === 'pending' && t <= c.expiresAt) return { charge: view(c), code: codeFor(c), reused: true };
    }
    const charge = {
      id: crypto.randomBytes(6).toString('hex'), deviceId, device: String(device || '').slice(0, 80),
      visitor: String(visitor || '').slice(0, 80), amountCents: state.settings.pix.amountCents, status: 'pending',
      createdAt: t, expiresAt: t + VALID_MS, paidAt: 0, eventAt: 0, mailId: '', grantedUntil: 0
    };
    state.charges.set(charge.id, charge);
    trim();
    await saveCharge(charge);
    return { charge: view(charge), code: codeFor(charge), reused: false };
  }

  async function doRefresh(force) {
    await ready();
    const t = now();
    for (const c of state.charges.values()) {
      if (c.status === 'pending' && t > c.expiresAt + GRACE_MS) { c.status = 'expired'; await saveCharge(c); }
    }
    const pending = [...state.charges.values()].filter((c) => c.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    if (!pending.length || !state.settings.microUrl || !secret) return;
    if (!force && t - state.lastFetchAt < POLL_MIN_MS) return;
    state.lastFetchAt = t;
    let data;
    try {
      data = await getEvents({ url: state.settings.microUrl, secret, since: pending[0].createdAt - EARLY_MS - 60000 });
      state.micro.lastOkAt = now(); state.micro.lastError = '';
      state.micro.lastPushAt = Number(data.lastPushAt) || 0;
      state.micro.rejected = Array.isArray(data.rejected) ? data.rejected.slice(0, 5) : [];
    } catch (err) {
      state.micro.lastError = err.message;
      return;
    }
    const used = new Set([...state.charges.values()].map((c) => c.mailId).filter(Boolean));
    for (const { charge, event } of matchEvents(pending, Array.isArray(data.events) ? data.events : [], used)) {
      charge.status = 'paid';
      charge.paidAt = now();
      charge.eventAt = event.at;
      charge.mailId = event.id;
      charge.grantedUntil = charge.paidAt + ACCESS_MS;
      await saveCharge(charge);
    }
  }

  function refresh(force) {
    if (!state.refreshing) state.refreshing = doRefresh(force).finally(() => { state.refreshing = null; });
    return state.refreshing;
  }

  async function poll(id, deviceId) {
    await refresh(false);
    const c = state.charges.get(String(id));
    if (!c || (deviceId && c.deviceId !== deviceId)) return null;
    return { charge: view(c), access: access(c.deviceId) };
  }

  /** Conferência manual do nó: URL certa, chave aceita, quando o Apps Script falou por último e o que ele recusou. */
  async function pingMicro() {
    await ready();
    if (!state.settings.microUrl) throw new Error('Salve antes a URL do nó.');
    if (!secret) throw new Error('Sem chave: configure o Supabase no Render (a chave do nó é derivada dele).');
    const data = await getEvents({ url: state.settings.microUrl, secret, since: now() - 3600000 });
    state.micro.lastOkAt = now(); state.micro.lastError = '';
    state.micro.lastPushAt = Number(data.lastPushAt) || 0;
    state.micro.rejected = Array.isArray(data.rejected) ? data.rejected.slice(0, 5) : [];
    return { ...state.micro, events: Array.isArray(data.events) ? data.events.length : 0 };
  }

  async function getState(deviceId) {
    await ready();
    const t = now();
    const mine = [...state.charges.values()].filter((c) => c.deviceId === deviceId && c.status === 'pending' && t <= c.expiresAt)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return {
      settings: publicSettings(),
      persist: { ...state.persist },
      micro: { ...state.micro },
      access: access(deviceId),
      current: mine ? { charge: view(mine), code: codeFor(mine) } : null,
      history: [...state.charges.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 15).map(view),
      now: t
    };
  }

  return {
    ready, saveSettings, createCharge, poll, pingMicro, getState, access,
    getSecret: () => secret,
    getMicroUrl: () => state.settings.microUrl,
    _state: state
  };
}

module.exports = {
  createPix, buildPayload, parsePayload, crc16, matchEvents, deriveMailSecret,
  ACCESS_MS, VALID_MS, GRACE_MS, EARLY_MS
};
