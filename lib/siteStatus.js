'use strict';

/**
 * Estado do site para os visitantes: "em manutenção" e "mudamos de URL" (dois switches do administrador).
 *
 *   maintenance { on, message }   tela animada "voltamos em breve" e a API recusa os visitantes (503); o admin passa
 *   moved       { on, url }       tela animada "mudamos de endereço" com botão/redirecionamento para a URL nova
 *
 * Guardado no Supabase na tabela que já existe do Pix (public.pix_settings, chave "site_status"): nada novo para criar.
 * Sem Supabase (ou sem a tabela) fica na memória do servidor. O servidor decide na hora a partir de um cache em memória,
 * renovado do Supabase a cada 20 s (vale também para mais de uma instância do Render).
 */

const KEY = 'site_status';
const STALE_MS = 20000;
const DEFAULT_MESSAGE = 'Estamos dando uma geral por aqui. Voltamos em breve!';

// Nunca bloqueados pela manutenção: o próprio estado, a saúde (o Render usa) e a checagem da senha.
const EXEMPT = ['/api/site/', '/api/health', '/api/admin/check'];

const EMPTY = () => ({ maintenance: { on: false, message: '' }, moved: { on: false, url: '' }, updatedAt: 0 });

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`); } catch (err) { throw new Error('A URL nova não é válida.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('A URL nova precisa ser http(s).');
  if (u.username || u.password) throw new Error('A URL nova não pode ter usuário e senha.');
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('A URL nova não parece um endereço (falta o domínio).');
  const href = u.href.replace(/\/$/, u.pathname === '/' && !u.search && !u.hash ? '' : '/');
  if (href.length > 300) throw new Error('A URL nova é longa demais.');
  return href;
}

/** Valida o que o admin mandou. Lança erro com mensagem em português. */
function normalize(input, now = Date.now()) {
  const m = (input && input.maintenance) || {};
  const v = (input && input.moved) || {};
  const out = {
    maintenance: { on: m.on === true, message: cleanText(m.message, 200) },
    moved: { on: v.on === true, url: cleanUrl(v.url) },
    updatedAt: now
  };
  if (out.moved.on && !out.moved.url) throw new Error('Para ligar "mudamos de URL" informe o endereço novo.');
  return out;
}

/** Pura (testável): essa requisição deve levar 503 por causa da manutenção? */
function blockedByMaintenance(path, status, isAdmin) {
  if (!status || !status.maintenance || !status.maintenance.on || isAdmin) return false;
  const p = String(path || '');
  if (p !== '/api' && !p.startsWith('/api/') && !p.startsWith('/hls/')) return false;
  return !EXEMPT.some((e) => p === e || p.startsWith(e));
}

function createSiteStatus(deps = {}) {
  const now = deps.now || Date.now;
  const db = deps.db || require('./usageStore');
  const state = {
    value: EMPTY(), loaded: false, loading: null, nextLoadAt: 0, loadedAt: 0,
    persist: { enabled: false, tablesMissing: false, lastError: '' }
  };
  const quiet = { quiet: true };

  async function load() {
    state.persist.enabled = Boolean(db.enabled());
    if (!state.persist.enabled) { state.loaded = true; state.loadedAt = now(); return; }
    try {
      const rows = await db.call('GET', `/pix_settings?select=v&k=eq.${KEY}`, undefined, undefined, quiet);
      if (rows && rows[0] && rows[0].v) {
        const v = rows[0].v;
        state.value = {
          maintenance: { on: Boolean(v.maintenance && v.maintenance.on), message: cleanText(v.maintenance && v.maintenance.message, 200) },
          moved: { on: Boolean(v.moved && v.moved.on), url: String((v.moved && v.moved.url) || '') },
          updatedAt: Number(v.updatedAt) || 0
        };
      }
      state.persist.tablesMissing = false;
      state.persist.lastError = '';
      state.loaded = true;
      state.loadedAt = now();
    } catch (err) {
      state.persist.tablesMissing = Boolean(err.tablesMissing);
      state.persist.lastError = err.message;
      if (err.tablesMissing) { state.loaded = true; state.loadedAt = now(); } else state.nextLoadAt = now() + 15000; // falha de rede: tenta de novo logo (sem bloquear)
    }
  }

  function startLoad() {
    if (!state.loading) state.loading = load().finally(() => { state.loading = null; });
    return state.loading;
  }

  /** Primeira carga (o servidor acabou de acordar): espera. Depois só renova em segundo plano. */
  async function ready() {
    if (!state.loaded) {
      if (now() >= state.nextLoadAt) await startLoad();
      return;
    }
    if (state.persist.enabled && !state.persist.tablesMissing && now() - state.loadedAt > STALE_MS) startLoad();
  }

  async function set(input) {
    await ready();
    const next = normalize(input, now());
    state.value = next;
    if (state.persist.enabled && !state.persist.tablesMissing) {
      try {
        await db.call('POST', '/pix_settings?on_conflict=k', { k: KEY, v: next, updated_at: new Date(now()).toISOString() },
          { Prefer: 'resolution=merge-duplicates,return=minimal' }, quiet);
        state.persist.lastError = '';
        state.loadedAt = now();
      } catch (err) {
        state.persist.lastError = err.message;
        if (err.tablesMissing) state.persist.tablesMissing = true;
      }
    }
    return adminView();
  }

  const snapshot = () => state.value;

  function publicView() {
    const v = state.value;
    return {
      maintenance: { on: v.maintenance.on, message: v.maintenance.message || DEFAULT_MESSAGE },
      moved: { on: v.moved.on, url: v.moved.on ? v.moved.url : '' },
      updatedAt: v.updatedAt,
      now: now()
    };
  }

  function adminView() {
    const v = state.value;
    return {
      maintenance: { ...v.maintenance }, moved: { ...v.moved }, updatedAt: v.updatedAt,
      defaultMessage: DEFAULT_MESSAGE, persist: { ...state.persist }, now: now()
    };
  }

  return { ready, set, snapshot, publicView, adminView, _state: state };
}

module.exports = { createSiteStatus, normalize, blockedByMaintenance, cleanUrl, DEFAULT_MESSAGE, EXEMPT };
