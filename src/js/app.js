// ============================================================
// RouterDex - app.js
// ============================================================

// ============================================================
// CONFIG
// ============================================================

const API_URL        = 'https://openrouter.ai/api/v1/models';
const LEADERBOARD_URL = 'https://raw.githubusercontent.com/fr4nk-crux/RouterDex/main/public/data/leaderboard.json';
const CACHE_KEY      = 'routerdex_models';
const CACHE_TTL      = 24 * 60 * 60 * 1000;
const DEBOUNCE       = 300;

// ============================================================
// STATE
// ============================================================

let leaderboardData = null;

const state = {
  models:         [],
  filtered:       [],
  activeModelId:  null,
  activeProvider: null,
  searchQuery:    '',
  categoryFilter: null,
  cacheTimestamp: null,
  compareList:    [], // max 4
};

// ============================================================
// TAURI WINDOW CONTROLS
// ============================================================

function initWindowControls() {
  const tauri = window.__TAURI__?.window;
  if (!tauri) return;
  const win = tauri.getCurrentWindow();
  document.getElementById('btn-minimize').addEventListener('click', () => win.minimize());
  document.getElementById('btn-maximize').addEventListener('click', async () => {
    (await win.isMaximized()) ? win.unmaximize() : win.maximize();
  });
  document.getElementById('btn-close').addEventListener('click', () => win.close());
  document.getElementById('titlebar').addEventListener('dblclick', async (e) => {
    if (e.target.closest('.titlebar-buttons')) return;
    (await win.isMaximized()) ? win.unmaximize() : win.maximize();
  });
}

// ============================================================
// CACHE
// ============================================================

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    if (!cache.data || !cache.timestamp) return null;
    return cache;
  } catch { return null; }
}

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now(), version: '1.0' }));
  } catch (e) { console.warn('Cache write failed:', e); }
}

function isCacheValid(cache) {
  return cache && (Date.now() - cache.timestamp) < CACHE_TTL;
}

// ============================================================
// API
// ============================================================

async function fetchModels() {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).data;
}

// ============================================================
// DATA TRANSFORM
// ============================================================

function transformModel(raw) {
  const id       = raw.id || '';
  const parts    = id.split('/');
  const provider = parts[0] || 'unknown';
  const slug     = parts.slice(1).join('/') || id;

  const priceInput  = raw.pricing?.prompt     || '0';
  const priceOutput = raw.pricing?.completion || '0';
  const cacheRead   = raw.pricing?.input_cache_read   || null;
  const cacheWrite  = raw.pricing?.input_cache_write  || null;
  const webSearch   = raw.pricing?.web_search         || null;

  const inputTypes  = raw.architecture?.input_modalities  || ['text'];
  const outputTypes = raw.architecture?.output_modalities || ['text'];
  const modality    = raw.architecture?.modality || '';
  const supportedParams = raw.supported_parameters || [];

  const isFree      = priceInput === '0' && priceOutput === '0';
  const isReasoning = supportedParams.includes('reasoning');
  const nameLC      = (raw.name || '').toLowerCase();
  const descLC      = (raw.description || '').toLowerCase();
  const isCode      = nameLC.includes('code') || nameLC.includes('codex')
                   || descLC.includes('code') || descLC.includes('codex');

  // Classification based on OUTPUT only
  const outImage = outputTypes.includes('image');
  const outAudio = outputTypes.includes('audio');

  // Output capabilities (for tags)
  const hasVision = outImage;
  const hasAudio  = outAudio;
  const hasVideo  = false; // No video output models on OpenRouter

  let category = 'text';
  if (outImage)      category = 'image-gen';
  else if (outAudio) category = 'audio';
  // multimodal = text output but accepts multiple input types
  else if (inputTypes.includes('image') || inputTypes.includes('audio') || inputTypes.includes('video')) category = 'multimodal';

  return {
    modelId: id, displayName: raw.name || slug,
    description: raw.description || '', createdAt: raw.created || 0,
    contextWindow: raw.context_length || 0,
    priceInput, priceOutput, priceCacheRead: cacheRead,
    priceCacheWrite: cacheWrite, priceWebSearch: webSearch,
    priceInputPerM:  parseFloat(priceInput)  * 1_000_000,
    priceOutputPerM: parseFloat(priceOutput) * 1_000_000,
    isFree, hasVision, hasAudio, hasVideo, isReasoning, isCode,
    isModerated: raw.top_provider?.is_moderated ?? null,
    maxOutputTokens: raw.top_provider?.max_completion_tokens || null,
    inputTypes, outputTypes, modality, category, supportedParams,
    providerId: provider, modelSlug: slug,
  };
}

function transformAll(rawList) {
  return rawList.map(transformModel);
}

// ============================================================
// LOAD FLOW
// ============================================================

async function fetchLeaderboard() {
  try {
    const res = await fetch(LEADERBOARD_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    leaderboardData = await res.json();
  } catch (err) {
    console.warn('Leaderboard fetch failed, trying local:', err);
    try {
      const res = await fetch('/data/leaderboard.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      leaderboardData = await res.json();
    } catch (e) {
      console.warn('Local leaderboard also failed:', e);
      leaderboardData = null;
    }
  }
}

async function loadData() {
  showState('loading');
  const cache = loadCache();
  if (isCacheValid(cache)) {
    state.models = transformAll(cache.data);
    state.cacheTimestamp = cache.timestamp;
    await fetchLeaderboard();
    onDataReady();
    return;
  }
  try {
    const [raw] = await Promise.all([fetchModels(), fetchLeaderboard()]);
    saveCache(raw);
    state.models = transformAll(raw);
    state.cacheTimestamp = Date.now();
    onDataReady();
  } catch (err) {
    console.error('Fetch failed:', err);
    if (cache) {
      state.models = transformAll(cache.data);
      state.cacheTimestamp = cache.timestamp;
      await fetchLeaderboard();
      onDataReady(true);
    } else {
      showState('error', 'Unable to load models. Check your connection.');
    }
  }
}

function onDataReady(stale = false) {
  state.filtered = [...state.models];
  renderSidebar();
  updateStatusBar(stale);
  showPage('home');
  renderHomePage();
}

// ============================================================
// SIDEBAR
// ============================================================

function renderSidebar() {
  const container = document.getElementById('sidebar-providers');
  const groups = {};
  for (const m of state.filtered) {
    if (!groups[m.providerId]) groups[m.providerId] = [];
    groups[m.providerId].push(m);
  }

  if (Object.keys(groups).length === 0) {
    container.innerHTML = `<div class="sidebar-empty">No results${state.searchQuery ? ` for "${state.searchQuery}"` : ''}</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const pid of Object.keys(groups).sort()) {
    const models = groups[pid];
    const div = document.createElement('div');
    div.className = 'provider-item';
    div.dataset.provider = pid;
    div.dataset.expanded = state.activeProvider === pid ? 'true' : 'false';

    div.innerHTML = `
      <div class="provider-header" tabindex="0">
        <span class="expand-icon">▸</span>
        <span class="provider-name">${capitalize(pid)}</span>
        <span class="model-count">(${models.length})</span>
      </div>
      <div class="provider-models"></div>
    `;

    const header    = div.querySelector('.provider-header');
    const modelsDiv = div.querySelector('.provider-models');
    let rendered    = false;

    const tryRender = () => {
      if (!rendered) { renderProviderModels(modelsDiv, models); rendered = true; }
    };

    // Auto-expand active provider
    if (state.activeProvider === pid) tryRender();

    header.addEventListener('click', () => {
      const expanded = div.dataset.expanded === 'true';
      div.dataset.expanded = expanded ? 'false' : 'true';
      if (!expanded) tryRender();
    });

    frag.appendChild(div);
  }

  container.innerHTML = '';
  container.appendChild(frag);
}

function renderProviderModels(container, models) {
  const maxCompare = state.compareList.length >= 4;
  const frag = document.createDocumentFragment();
  for (const m of models) {
    const div = document.createElement('div');
    div.className = 'model-item';
    div.dataset.id = m.modelId;

    const inCompare = state.compareList.includes(m.modelId);
    if (inCompare) div.classList.add('in-compare');
    if (m.modelId === state.activeModelId) div.classList.add('active');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = inCompare;
    cb.disabled = maxCompare && !inCompare;
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      toggleCompare(m.modelId);
    });

    const label = document.createElement('span');
    label.className = 'model-item-name';
    label.textContent = cleanModelName(m.displayName);

    div.appendChild(cb);
    div.appendChild(label);

    label.addEventListener('click', () => selectModel(m.modelId));
    frag.appendChild(div);
  }
  container.appendChild(frag);
}

// ============================================================
// HOME PAGE — PANELS
// ============================================================

const HOME_PANELS = [
  {
    id: 'leaderboard',
    title: 'Leaderboard',
    icon: 'leaderboard',
    custom: true,
  },
  {
    id: 'latest',
    title: 'Latest Models',
    icon: 'latest',
    filter: m => true,
    sort: (a, b) => b.createdAt - a.createdAt,
    value: m => formatDate(m.createdAt),
    ranked: false,
  },
  {
    id: 'free',
    title: 'Free Models',
    icon: 'free',
    filter: m => m.isFree,
    sort: (a, b) => b.contextWindow - a.contextWindow,
    value: m => formatCtx(m.contextWindow),
    ranked: false,
  },
  {
    id: 'context',
    title: 'Top Context Window',
    icon: 'context',
    filter: m => true,
    sort: (a, b) => b.contextWindow - a.contextWindow,
    value: m => formatCtx(m.contextWindow),
    ranked: true,
  },
  {
    id: 'multimodal',
    title: 'Multimodal',
    icon: 'multimodal',
    filter: m => m.category === 'multimodal', // text output + multi input
    sort: (a, b) => b.createdAt - a.createdAt,
    value: m => m.providerId,
    ranked: false,
  },
  {
    id: 'text',
    title: 'Text',
    icon: 'text',
    filter: m => m.category === 'text',
    sort: (a, b) => b.createdAt - a.createdAt,
    value: m => m.providerId,
    ranked: false,
  },
  {
    id: 'audio',
    title: 'Audio',
    icon: 'audio',
    filter: m => m.category === 'audio',
    sort: (a, b) => b.createdAt - a.createdAt,
    value: m => m.providerId,
    ranked: false,
  },
  {
    id: 'image',
    title: 'Image',
    icon: 'image',
    filter: m => m.category === 'image-gen',
    sort: (a, b) => b.createdAt - a.createdAt,
    value: m => m.providerId,
    ranked: false,
  },
];

function renderHomePage() {
  const grid = document.getElementById('home-panels-grid');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const panel of HOME_PANELS) {
    const el = document.createElement('div');
    el.className = 'home-panel';
    el.dataset.panelId = panel.id;

    el.innerHTML = `
      <div class="home-panel-header">
        <img src="/assets/icons/${panel.icon}.svg" width="20" height="20" alt="" onerror="this.style.display='none'" />
        ${panel.title}
      </div>
      <div class="home-panel-body" id="panel-body-${panel.id}"></div>
    `;

    const body = el.querySelector(`#panel-body-${panel.id}`);

    if (panel.custom) {
      renderLeaderboardPanel(body);
    } else {
      const rows = state.models.filter(panel.filter).sort(panel.sort).slice(0, 20);
      if (!rows.length) {
        body.innerHTML = '<div class="panel-row"><span class="panel-row-name" style="color:var(--text-secondary);font-style:italic">No models</span></div>';
      } else {
        const rfrag = document.createDocumentFragment();
        rows.forEach((m, i) => {
          const row = document.createElement('div');
          row.className = 'panel-row';
          row.innerHTML = `
            ${panel.ranked ? `<span class="panel-row-rank">${i + 1}.</span>` : ''}
            <span class="panel-row-name">${cleanModelName(m.displayName)}</span>
            <span class="panel-row-provider">
              <img src="/assets/providers/${m.providerId}.svg" width="12" height="12" alt="" onerror="this.style.display='none'" />
              ${m.providerId}
            </span>
            <span class="panel-row-value">${panel.value(m)}</span>
          `;
          row.addEventListener('click', () => selectModel(m.modelId));
          rfrag.appendChild(row);
        });
        body.appendChild(rfrag);
      }
    }

    frag.appendChild(el);
  }

  grid.appendChild(frag);
}

// ============================================================
// LEADERBOARD PANEL
// ============================================================

function renderLeaderboardPanel(container) {
  if (!leaderboardData) {
    container.innerHTML = '<div class="panel-placeholder">Unable to load leaderboard</div>';
    return;
  }

  const { top_models, top_apps, updated } = leaderboardData;
  const updatedAgo = formatTimeAgo(new Date(updated));

  container.innerHTML = `
    <div class="leaderboard-header">
      <div class="leaderboard-toggle">
        <button class="leaderboard-tab active" data-tab="models">Models</button>
        <button class="leaderboard-tab" data-tab="apps">Apps</button>
      </div>
      <span class="leaderboard-updated">Updated: ${updatedAgo}</span>
    </div>
    <div class="leaderboard-content" id="leaderboard-models"></div>
    <div class="leaderboard-content hidden" id="leaderboard-apps"></div>
  `;

  renderLeaderboardModels(container.querySelector('#leaderboard-models'), top_models);
  renderLeaderboardApps(container.querySelector('#leaderboard-apps'), top_apps);

  container.querySelectorAll('.leaderboard-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.leaderboard-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      container.querySelector('#leaderboard-models').classList.toggle('hidden', target !== 'models');
      container.querySelector('#leaderboard-apps').classList.toggle('hidden', target !== 'apps');
    });
  });
}

function renderLeaderboardModels(container, models) {
  const medals = ['🥇', '🥈', '🥉'];
  container.innerHTML = models.map(m => `
    <div class="panel-row leaderboard-row" data-model-id="${m.model_id}">
      <span class="panel-row-rank">${medals[m.rank - 1] || m.rank + '.'}</span>
      <span class="panel-row-name">${m.name}</span>
      <span class="panel-row-provider">
        <img src="/assets/providers/${m.provider}.svg" width="12" height="12" alt="" onerror="this.style.display='none'" />
        ${m.provider}
      </span>
      <span class="panel-row-value">${formatTokens(m.tokens)}</span>
      <span class="leaderboard-change ${m.change_direction === 'up' ? 'up' : m.change_direction === 'down' ? 'down' : ''}">${formatChange(m.change_pct, m.change_direction)}</span>
    </div>
  `).join('');

  container.querySelectorAll('.leaderboard-row').forEach(row => {
    row.addEventListener('click', () => selectModel(row.dataset.modelId));
  });
}

function renderLeaderboardApps(container, apps) {
  container.innerHTML = apps.map(a => `
    <div class="panel-row leaderboard-row" data-url="${a.url}">
      <span class="panel-row-rank">${a.rank}.</span>
      <span class="panel-row-name">${a.name}</span>
      <span class="leaderboard-desc">${a.description}</span>
      <span class="panel-row-value">${formatTokens(a.tokens)}</span>
    </div>
  `).join('');

  container.querySelectorAll('.leaderboard-row').forEach(row => {
    row.addEventListener('click', () => window.open(row.dataset.url, '_blank'));
  });
}

function formatChange(pct, direction) {
  if (!pct) return '—';
  if (direction === 'up')   return `▲ ${pct}%`;
  if (direction === 'down') return `▼ ${pct}%`;
  return '—';
}

function formatTokens(tokens) {
  return tokens.replace(/([\d.]+)([TBMK])/, '$1 $2') + '/Tokens';
}

function formatTimeAgo(date) {
  const diff  = Date.now() - date;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days  = Math.floor(hours / 24);
  if (days > 0)  return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return 'just now';
}

// ============================================================
// MODEL DETAIL
// ============================================================

function selectModel(modelId) {
  const model = state.models.find(m => m.modelId === modelId);
  if (!model) return;

  state.activeModelId  = modelId;
  state.activeProvider = model.providerId;

  document.querySelectorAll('.model-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === modelId);
  });
  document.querySelectorAll('.sidebar-nav-item').forEach(el => el.classList.remove('active'));

  showPage('model');
  renderModelPage(model);
}

function renderModelPage(model) {
  // Header
  const logo = document.getElementById('model-provider-logo');
  logo.src = `/assets/providers/${model.providerId}.svg`;
  logo.style.display = '';
  document.getElementById('model-provider-label').textContent = model.providerId.toUpperCase();
  document.getElementById('model-name').textContent = cleanModelName(model.displayName);
  document.getElementById('model-link').href = `https://openrouter.ai/models/${model.modelId}`;

  // Tags
  renderTags(model, 'model-tags');

  // KPI Bar
  document.getElementById('kpi-context').textContent    = model.contextWindow ? formatCtx(model.contextWindow) : '—';
  document.getElementById('kpi-max-output').textContent = model.maxOutputTokens ? formatCtx(model.maxOutputTokens) : '—';

  if (model.isFree) {
    document.getElementById('kpi-price-input').innerHTML  = '<span class="badge badge-free">FREE</span>';
    document.getElementById('kpi-price-output').innerHTML = '<span class="badge badge-free">FREE</span>';
  } else {
    document.getElementById('kpi-price-input').textContent  = `$${fmtPrice(model.priceInputPerM)}/M`;
    document.getElementById('kpi-price-output').textContent = `$${fmtPrice(model.priceOutputPerM)}/M`;
  }

  // Details card
  document.getElementById('info-id').textContent       = model.modelId;
  document.getElementById('info-provider').textContent = capitalize(model.providerId);
  document.getElementById('info-date').textContent     = model.createdAt ? formatDateLong(model.createdAt) : '—';
  document.getElementById('info-moderated').textContent = model.isModerated === true ? '✅ Yes' : model.isModerated === false ? '❌ No' : '—';
  document.getElementById('info-modality').textContent = model.modality || '—';
  document.getElementById('cap-input').textContent  = model.inputTypes.join(', ');
  document.getElementById('cap-output').textContent = model.outputTypes.join(', ');

  // Pricing card
  renderPricing(model);

  // Description
  document.getElementById('model-description').textContent = model.description || 'No description available.';

  // Parameters
  document.getElementById('model-params').textContent = model.supportedParams.length
    ? model.supportedParams.join(', ')
    : '—';
}

function renderPricing(model) {
  const table = document.getElementById('pricing-table');
  const rows  = [];
  if (model.isFree) {
    rows.push(['Status', '<span class="badge badge-free">FREE</span>']);
  } else {
    rows.push(['Input',  `$${fmtPrice(model.priceInputPerM)} / 1M`]);
    rows.push(['Output', `$${fmtPrice(model.priceOutputPerM)} / 1M`]);
    if (model.priceCacheRead)  rows.push(['Cache read',  `$${fmtPrice(parseFloat(model.priceCacheRead)  * 1_000_000)} / 1M`]);
    if (model.priceCacheWrite) rows.push(['Cache write', `$${fmtPrice(parseFloat(model.priceCacheWrite) * 1_000_000)} / 1M`]);
    if (model.priceWebSearch)  rows.push(['Web search',  `$${fmtPrice(parseFloat(model.priceWebSearch)  * 1_000_000)} / 1M`]);
  }
  table.innerHTML = rows.map(([label, value]) => `
    <div class="info-row">
      <span class="info-label">${label}</span>
      <span class="info-value">${value}</span>
    </div>
  `).join('');
}

function renderTags(model, containerId) {
  const container = document.getElementById(containerId);
  const tags = buildTagList(model);
  container.innerHTML = tags.map(t =>
    `<span class="badge badge-${t}">${t === 'image-gen' ? 'Image Gen' : capitalize(t)}</span>`
  ).join('');
}

// ============================================================
// COMPARE FEATURE
// ============================================================

function toggleCompare(modelId) {
  const idx = state.compareList.indexOf(modelId);
  if (idx === -1) {
    if (state.compareList.length >= 4) return;
    state.compareList.push(modelId);
  } else {
    state.compareList.splice(idx, 1);
  }
  updateCompareBar();
  // Re-render open provider model lists to sync checkboxes
  document.querySelectorAll('.provider-item[data-expanded="true"] .provider-models').forEach(modelsDiv => {
    const pid = modelsDiv.closest('.provider-item').dataset.provider;
    modelsDiv.innerHTML = '';
    const models = state.filtered.filter(m => m.providerId === pid);
    renderProviderModels(modelsDiv, models);
  });
}

function updateCompareBar() {
  const bar   = document.getElementById('sidebar-compare');
  const count = state.compareList.length;
  document.getElementById('compare-count').textContent = count;
  bar.classList.toggle('hidden', count < 2);
}

function renderComparePage() {
  const grid = document.getElementById('compare-grid');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const modelId of state.compareList) {
    const m = state.models.find(x => x.modelId === modelId);
    if (!m) continue;

    const card = document.createElement('div');
    card.className = 'compare-card';

    const tags = buildTagList(m).map(t =>
      `<span class="badge badge-${t}">${t === 'image-gen' ? 'Image Gen' : capitalize(t)}</span>`
    ).join('');

    card.innerHTML = `
      <div class="compare-card-header">
        <div class="compare-card-provider">
          <img src="/assets/providers/${m.providerId}.svg" width="16" height="16" alt="" onerror="this.style.display='none'" />
          ${capitalize(m.providerId)}
        </div>
        <div class="compare-card-name">${cleanModelName(m.displayName)}</div>
      </div>
      <div class="compare-card-body">
        <div class="compare-row"><div class="compare-row-label">Context Window</div><div class="compare-row-value">${formatCtx(m.contextWindow)}</div></div>
        <div class="compare-row"><div class="compare-row-label">Max Output</div><div class="compare-row-value">${m.maxOutputTokens ? formatCtx(m.maxOutputTokens) : '—'}</div></div>
        <div class="compare-row"><div class="compare-row-label">Input Price</div><div class="compare-row-value">${m.isFree ? '<span class="badge badge-free">FREE</span>' : `$${fmtPrice(m.priceInputPerM)}/M`}</div></div>
        <div class="compare-row"><div class="compare-row-label">Output Price</div><div class="compare-row-value">${m.isFree ? '<span class="badge badge-free">FREE</span>' : `$${fmtPrice(m.priceOutputPerM)}/M`}</div></div>
        <div class="compare-row"><div class="compare-row-label">Modality</div><div class="compare-row-value">${m.modality || '—'}</div></div>
        <div class="compare-row"><div class="compare-row-label">Input</div><div class="compare-row-value">${m.inputTypes.join(', ')}</div></div>
        <div class="compare-row"><div class="compare-row-label">Output</div><div class="compare-row-value">${m.outputTypes.join(', ')}</div></div>
        <div class="compare-row"><div class="compare-row-label">Moderated</div><div class="compare-row-value">${m.isModerated === true ? '✅ Yes' : m.isModerated === false ? '❌ No' : '—'}</div></div>
        <div class="compare-row"><div class="compare-row-label">Tags</div><div class="compare-row-value">${tags}</div></div>
      </div>
      <div class="compare-card-footer">
        <button class="btn-remove-compare" data-id="${m.modelId}">✕ Remove</button>
      </div>
    `;

    card.querySelector('.compare-card-name').addEventListener('click', () => selectModel(m.modelId));
    card.querySelector('.btn-remove-compare').addEventListener('click', () => {
      toggleCompare(m.modelId);
      renderComparePage();
      updateCompareBar();
      if (state.compareList.length === 0) { showPage('home'); renderHomePage(); }
    });

    frag.appendChild(card);
  }

  grid.appendChild(frag);
}

function clearCompare() {
  state.compareList = [];
  updateCompareBar();
  renderSidebar();
}

// ============================================================
// EXPORT JSON
// ============================================================

function buildTagList(model) {
  const tags = [];
  if (model.isFree)                        tags.push('free');
  if (model.category === 'multimodal')     tags.push('multimodal');
  if (model.hasVision)                     tags.push('vision');
  if (model.hasAudio)                      tags.push('audio');
  if (model.isCode)                        tags.push('code');
  if (model.isReasoning)                   tags.push('reasoning');
  if (model.category === 'image-gen')      tags.push('image-gen');
  if (!tags.length)                        tags.push('text');
  return tags;
}

function exportJSON() {
  const data = {
    export_date: new Date().toISOString(),
    source: 'OpenRouter API',
    total_models: state.models.length,
    models: state.models.map(m => ({
      id: m.modelId,
      name: cleanModelName(m.displayName),
      provider: m.providerId,
      description: m.description,
      created: m.createdAt,
      context_window: m.contextWindow,
      max_output_tokens: m.maxOutputTokens,
      pricing: {
        input_per_million:       m.priceInputPerM,
        output_per_million:      m.priceOutputPerM,
        cache_read_per_million:  m.priceCacheRead  ? parseFloat(m.priceCacheRead)  * 1_000_000 : null,
        cache_write_per_million: m.priceCacheWrite ? parseFloat(m.priceCacheWrite) * 1_000_000 : null,
        web_search_per_million:  m.priceWebSearch  ? parseFloat(m.priceWebSearch)  * 1_000_000 : null,
      },
      is_free: m.isFree,
      is_moderated: m.isModerated,
      modality: { input: m.inputTypes, output: m.outputTypes },
      category: m.category,
      tags: buildTagList(m),
      supported_parameters: m.supportedParams,
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `routerdex_export_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// SEARCH + FILTERS
// ============================================================

let searchTimeout;

function onSearch(query) {
  state.searchQuery = query.trim().toLowerCase();
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(applyFilters, DEBOUNCE);
}

function applyFilters() {
  let results = state.models;
  if (state.searchQuery) {
    results = results.filter(m =>
      m.displayName.toLowerCase().includes(state.searchQuery) ||
      m.modelId.toLowerCase().includes(state.searchQuery) ||
      m.providerId.toLowerCase().includes(state.searchQuery)
    );
  }
  if (state.categoryFilter) {
    results = results.filter(m => {
      if (state.categoryFilter === 'free')      return m.isFree;
      if (state.categoryFilter === 'code')      return m.isCode;
      if (state.categoryFilter === 'reasoning') return m.isReasoning;
      return m.category === state.categoryFilter;
    });
  }
  state.filtered = results;
  renderSidebar();
}

// ============================================================
// MENU BAR
// ============================================================

function initMenuBar() {
  document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = item.classList.contains('open');
      closeAllMenus();
      if (!isOpen) item.classList.add('open');
    });
  });
  document.addEventListener('click', closeAllMenus);
  document.querySelectorAll('.menu-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      handleMenuAction(opt.dataset.action);
      closeAllMenus();
    });
  });
}

function closeAllMenus() {
  document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
}

function handleMenuAction(action) {
  switch (action) {
    case 'refresh':
      localStorage.removeItem(CACHE_KEY);
      loadData();
      break;
    case 'export':
      exportJSON();
      break;
    case 'quit':
      window.__TAURI__?.window?.getCurrentWindow()?.close();
      break;
    case 'view-home':
      showPage('home');
      renderHomePage();
      break;
    case 'view-compare':
      if (state.compareList.length >= 2) { showPage('compare'); renderComparePage(); }
      break;
    case 'view-free':
      state.categoryFilter = 'free';
      applyFilters();
      break;
    case 'view-all':
      state.categoryFilter = null;
      state.searchQuery = '';
      document.getElementById('search-input').value = '';
      state.filtered = [...state.models];
      renderSidebar();
      break;
    case 'view-text':       state.categoryFilter = 'text';       applyFilters(); break;
    case 'view-multimodal': state.categoryFilter = 'multimodal'; applyFilters(); break;
    case 'view-image-gen':  state.categoryFilter = 'image-gen';  applyFilters(); break;
    case 'view-audio':      state.categoryFilter = 'audio';      applyFilters(); break;
    case 'about':
      alert('RouterDex v1.0\nAI Models Catalogue powered by OpenRouter');
      break;
    case 'openrouter-docs':
      window.open('https://openrouter.ai/docs', '_blank');
      break;
  }
}

// ============================================================
// STATUS BAR
// ============================================================

function updateStatusBar(stale = false) {
  document.getElementById('status-count').textContent   = `${state.models.length} models`;
  document.getElementById('status-updated').textContent = `Updated: ${state.cacheTimestamp ? formatDateLong(state.cacheTimestamp / 1000) : '—'}`;
  const onlineEl = document.getElementById('status-online');
  onlineEl.textContent = stale ? '● Offline (cached)' : '● Online';
  onlineEl.classList.toggle('offline', stale);
}

// ============================================================
// UI HELPERS
// ============================================================

function showState(name, message = '') {
  ['state-loading', 'state-error', 'page-home', 'page-model', 'page-compare'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  if (name === 'loading') document.getElementById('state-loading').classList.remove('hidden');
  if (name === 'error') {
    document.getElementById('error-message').textContent = message;
    document.getElementById('state-error').classList.remove('hidden');
  }
}

function showPage(name) {
  ['state-loading', 'state-error', 'page-home', 'page-model', 'page-compare'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  document.getElementById(`page-${name}`).classList.remove('hidden');
  if (name === 'home') {
    document.querySelectorAll('.sidebar-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.action === 'nav-home');
    });
  }
}

// ============================================================
// FORMAT HELPERS
// ============================================================

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function cleanModelName(name) {
  return name.replace(/^[^:]+:\s*/, '');
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function formatCtx(n) {
  if (!n) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateLong(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtPrice(n) {
  if (n === 0)   return '0.00';
  if (n < 0.01)  return n.toFixed(4);
  if (n < 1)     return n.toFixed(3);
  return n.toFixed(2);
}

// ============================================================
// RESIZE HANDLE
// ============================================================

function initResizeHandle() {
  const handle  = document.getElementById('resize-handle');
  const sidebar = document.getElementById('sidebar');
  let dragging  = false, startX, startW;

  handle.addEventListener('mousedown', (e) => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newW = Math.min(400, Math.max(180, startW + e.clientX - startX));
    sidebar.style.width = newW + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ============================================================
// SIDEBAR COLLAPSE
// ============================================================

function initSidebarToggle() {
  const sidebar   = document.getElementById('sidebar');
  const handle    = document.getElementById('resize-handle');
  const toggleBtn = document.getElementById('btn-sidebar-toggle');

  function updateToggle() {
    const collapsed = sidebar.classList.contains('collapsed');
    toggleBtn.textContent = collapsed ? '☰' : '✕';
    toggleBtn.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
  }

  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    handle.classList.toggle('hidden');
    updateToggle();
  });

  new ResizeObserver(() => {
    if (window.innerWidth < 1000 && !sidebar.classList.contains('collapsed')) {
      sidebar.classList.add('collapsed');
      handle.classList.add('hidden');
      updateToggle();
    }
  }).observe(document.body);
}

// ============================================================
// KEYBOARD NAV
// ============================================================

function initKeyboardNav() {
  document.addEventListener('keydown', (e) => {
    const input = document.getElementById('search-input');
    if (e.key === 'Escape') {
      if (document.activeElement === input && input.value) {
        input.value = '';
        state.searchQuery = '';
        state.categoryFilter = null;
        state.filtered = [...state.models];
        renderSidebar();
      } else {
        input.focus();
      }
    }
    if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      localStorage.removeItem(CACHE_KEY);
      loadData();
    }
    if (e.key === 'Home' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      showPage('home');
      renderHomePage();
    }
  });

  document.getElementById('sidebar-providers').addEventListener('keydown', (e) => {
    const items = [...document.querySelectorAll('.provider-header, .model-item-name')];
    const idx   = items.indexOf(document.activeElement);
    if (idx === -1) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(idx + 1, items.length - 1)]?.focus(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); items[Math.max(idx - 1, 0)]?.focus(); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.activeElement.click(); }
  });
}

// ============================================================
// INIT
// ============================================================

function init() {
  initWindowControls();
  initMenuBar();
  initResizeHandle();
  initSidebarToggle();
  initKeyboardNav();

  // Home nav
  document.querySelector('[data-action="nav-home"]').addEventListener('click', () => {
    showPage('home');
    renderHomePage();
  });

  // Search
  document.getElementById('search-input').addEventListener('input', e => onSearch(e.target.value));

  // Compare bar
  document.getElementById('btn-compare').addEventListener('click', () => {
    showPage('compare');
    renderComparePage();
  });
  document.getElementById('btn-compare-clear').addEventListener('click', () => {
    clearCompare();
  });
  document.getElementById('btn-compare-clear-all').addEventListener('click', () => {
    clearCompare();
    showPage('home');
    renderHomePage();
  });

  // Retry
  document.getElementById('btn-retry').addEventListener('click', loadData);

  loadData();
}

document.addEventListener('DOMContentLoaded', init);
