// Comparador de vuelos: con unos orígenes y unas fechas, busca los destinos más baratos
// y compara el precio desde cada origen.

import { AIRPORTS } from './airports.js';
import { DEFAULT_PROXY_URL } from './config.js';

const DEFAULT_ORIGINS = [
  { code: 'ALC', name: 'Alicante' },
  { code: 'KRK', name: 'Cracovia' },
  { code: 'MST', name: 'Maastricht' },
];

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado */ }
  },
};

let origins = store.get('origins', DEFAULT_ORIGINS);
let settings = store.get('settings', { proxyUrl: DEFAULT_PROXY_URL, currency: 'EUR' });
if (!settings.proxyUrl) settings.proxyUrl = DEFAULT_PROXY_URL;
let fixed = store.get('fixed', null); // código del aeropuerto fijo, o null

const $ = (sel) => document.querySelector(sel);
const colorOf = (i) => `var(--c${i % 5})`;
const fmtPrice = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: settings.currency, maximumFractionDigits: 0 }).format(n);
const fmtDay = (iso) => new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (iso) => (iso && iso.length > 10 ? iso.slice(11, 16) : '');
const AIRLINES = {
  FR: 'Ryanair', W6: 'Wizz Air', U2: 'easyJet', VY: 'Vueling', LO: 'LOT', HV: 'Transavia', IB: 'Iberia', UX: 'Air Europa',
  LH: 'Lufthansa', KL: 'KLM', AF: 'Air France', BA: 'British Airways', EW: 'Eurowings', LS: 'Jet2', V7: 'Volotea',
  TP: 'TAP', AZ: 'ITA Airways', SK: 'SAS', DY: 'Norwegian', TK: 'Turkish Airlines', PC: 'Pegasus', OS: 'Austrian', LX: 'Swiss',
};
const airlineName = (c) => (c ? (AIRLINES[c] ? `${AIRLINES[c]} (${c})` : c) : '—');
const fmtDuration = (min) => (min ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : '—');
const fmtStops = (n) => (n == null ? '—' : n === 0 ? 'Directo' : `${n} escala${n > 1 ? 's' : ''}`);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Fuentes de precios ----------

const DEMO_CITIES = [
  ['LON', 'Londres'], ['PAR', 'París'], ['ROM', 'Roma'], ['MIL', 'Milán'], ['BCN', 'Barcelona'], ['MAD', 'Madrid'],
  ['DUB', 'Dublín'], ['LIS', 'Lisboa'], ['OPO', 'Oporto'], ['BER', 'Berlín'], ['VIE', 'Viena'], ['PRG', 'Praga'],
  ['BUD', 'Budapest'], ['ATH', 'Atenas'], ['MLA', 'Malta'], ['AGP', 'Málaga'], ['PMI', 'Palma'], ['TFS', 'Tenerife'],
  ['NAP', 'Nápoles'], ['EDI', 'Edimburgo'], ['CPH', 'Copenhague'], ['STO', 'Estocolmo'], ['OSL', 'Oslo'], ['MRS', 'Marsella'],
  ['WAW', 'Varsovia'], ['GDN', 'Gdansk'], ['BRU', 'Bruselas'], ['AMS', 'Ámsterdam'], ['IST', 'Estambul'], ['RAK', 'Marrakech'],
];

// Demo: precios deterministas inventados, para probar la app sin claves.
function demoCheapest(origin, depart, ret) {
  let seed = [...(origin + depart + (ret || ''))].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const reach = origin === 'MST' ? 0.25 : 0.7; // Maastricht tiene muy pocas rutas
  const out = [];
  for (const [code, name] of DEMO_CITIES) {
    if (code === origin || rnd() > reach) continue;
    const transfers = rnd() < 0.6 ? 0 : 1;
    const h = String(6 + Math.floor(rnd() * 15)).padStart(2, '0');
    const airline = ['FR', 'W6', 'U2', 'VY', 'LO'][Math.floor(rnd() * 5)];
    const returnTransfers = rnd() < 0.6 ? 0 : 1;
    out.push({
      destination: code, name, price: Math.round((ret ? 50 : 25) + rnd() * 140), airline, transfers,
      departure_at: `${depart}T${h}:${rnd() < 0.5 ? '05' : '40'}`, return_at: ret ? `${ret}T${String(8 + Math.floor(rnd() * 13)).padStart(2, '0')}:20` : null,
      flight_number: String(1000 + Math.floor(rnd() * 8999)), origin_airport: origin, destination_airport: code,
      duration_to: 100 + Math.floor(rnd() * 120) + transfers * 150,
      duration_back: ret ? 100 + Math.floor(rnd() * 120) + returnTransfers * 150 : null,
      return_transfers: ret ? returnTransfers : null, link: null,
      return_airline: ret ? airline : null,
    });
  }
  return out;
}

// Sin escalas = directo en la ida y, si hay vuelta, también en la vuelta.
const isNonStop = (f) => f.transfers === 0 && !f.return_transfers;

async function getCheapest(origin, depart, ret, direct, flex) {
  let list;
  if (!settings.proxyUrl) {
    list = demoCheapest(origin, depart, ret);
  } else {
    const url = new URL('/cheapest', settings.proxyUrl);
    Object.entries({ origin, depart, return: ret || '', flex, currency: settings.currency.toLowerCase(), direct: direct ? '1' : '0' })
      .forEach(([k, v]) => url.searchParams.set(k, v));
    // Wizz Air va en otra llamada al proxy; si falla, se sigue con el resto.
    const wizz = new URL(url);
    wizz.pathname = '/wizz';
    const [res, wz] = await Promise.all([fetch(url), fetch(wizz).catch(() => null)]);
    if (!res.ok) throw new Error(`error ${res.status}`);
    list = (await res.json()).flights;
    if (wz?.ok) list = list.concat((await wz.json()).flights || []);
  }
  return direct ? list.filter(isNonStop) : list;
}

// Precio en directo (Google Flights vía SerpApi); gasta una búsqueda del plan gratuito.
async function getLive(origin, dest, depart, ret) {
  if (!settings.proxyUrl) return null;
  const url = new URL('/live', settings.proxyUrl);
  Object.entries({ origin, destination: dest, date: depart, return: ret || '', currency: settings.currency })
    .forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo consultar el precio en directo (error ${res.status})`);
  return (await res.json()).live;
}

// ---------- UI ----------

function renderOrigins() {
  const box = $('#origins');
  box.innerHTML = '';
  origins.forEach((o, i) => {
    const chip = document.createElement('span');
    chip.className = `chip${o.code === fixed ? ' fixed' : ''}`;
    chip.style.setProperty('--chip', colorOf(i));
    const pin = document.createElement('button');
    pin.className = 'pin';
    pin.textContent = '📌';
    pin.title = o.code === fixed ? 'Quitar como aeropuerto fijo' : 'Marcar como aeropuerto fijo';
    pin.ariaPressed = String(o.code === fixed);
    pin.onclick = () => setFixed(o.code === fixed ? null : o.code);
    chip.append(pin);
    chip.insertAdjacentHTML('beforeend', `${escapeHtml(o.code)} <small>${escapeHtml(o.name)}</small>`);
    const del = document.createElement('button');
    del.textContent = '✕';
    del.ariaLabel = `Quitar ${o.name}`;
    del.onclick = () => {
      origins.splice(i, 1);
      store.set('origins', origins);
      if (o.code === fixed) setFixed(null); else renderOrigins();
    };
    chip.append(del);
    box.append(chip);
  });
}

function setFixed(code) {
  fixed = code;
  store.set('fixed', fixed);
  renderOrigins();
  updateFixedUi();
  if (lastSearch) renderResults();
}

function updateFixedUi() {
  const o = origins.find((x) => x.code === fixed);
  $('#coverage').disabled = !!o;
  $('#fixed-note').textContent = o
    ? `Aeropuerto fijo: ${o.name}. Salen todos sus destinos, ordenados según su precio, y debajo los demás aeropuertos.`
    : 'Toca 📌 en un aeropuerto para fijarlo.';
}

function parsePlace(text) {
  // Acepta "VLC", "VLC · Valencia" o una sugerencia del autocompletado.
  const m = text.trim().match(/^([A-Za-z]{3})\b\s*(?:·\s*(.*))?$/);
  return m ? { code: m[1].toUpperCase(), name: m[2] || m[1].toUpperCase() } : null;
}

// Autocompletado local: escribe "ein" y salen Eindhoven, etc.
const norm = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const AIRPORT_INDEX = AIRPORTS.map(([code, city, name, country, cityOrig]) => ({
  code, city, name, country, words: norm(`${city} ${cityOrig} ${name}`).split(/[^a-z0-9]+/).filter(Boolean),
}));

function searchAirports(term) {
  const q = norm(term.trim());
  if (q.length < 2) return [];
  const scored = [];
  for (const a of AIRPORT_INDEX) {
    let score = null;
    if (norm(a.code) === q) score = 0;
    else if (norm(a.city).startsWith(q)) score = 1;
    else if (a.words.some((w) => w.startsWith(q))) score = 2;
    else if (q.length >= 3 && norm(a.code).startsWith(q)) score = 3;
    if (score !== null) scored.push([score, a]);
  }
  return scored.sort((x, y) => x[0] - y[0] || x[1].city.localeCompare(y[1].city)).slice(0, 8).map((x) => x[1]);
}

function wireAutocomplete(input, list, onPick) {
  let items = [];
  let active = -1;
  const close = () => { list.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); active = -1; };
  const paint = () => {
    list.innerHTML = items.map((a, i) => `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}">
      <b>${escapeHtml(a.code)}</b> <span>${escapeHtml(a.city)}</span> <small>${escapeHtml(a.name)} · ${escapeHtml(a.country)}</small></li>`).join('');
    list.classList.toggle('hidden', !items.length);
    input.setAttribute('aria-expanded', String(items.length > 0));
  };
  const pick = (a) => { onPick(a); input.value = ''; items = []; close(); };
  input.addEventListener('input', () => { items = searchAirports(input.value); active = items.length ? 0 : -1; paint(); });
  input.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { active = (active + 1) % items.length; paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; paint(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { pick(items[active]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); pick(items[li.dataset.i]); }
  });
  input.addEventListener('blur', close);
}

function addOrigin(p) {
  if (!p || origins.some((o) => o.code === p.code)) return;
  origins.push({ code: p.code, name: p.city || p.name });
  store.set('origins', origins);
  renderOrigins();
}

// Junta los resultados por destino: { code, name, byOrigin: { ALC: flight, ... }, options: { ALC: [...] }, best }
// byOrigin es el más barato desde cada origen; options, el más barato de cada aerolínea.
const airlineKey = (f) => `${f.airline || '?'}/${f.return_airline || f.airline || '?'}`;

function groupByDestination(perOrigin, fixedCode) {
  const map = new Map();
  for (const { origin, flights } of perOrigin) {
    for (const f of flights) {
      const d = map.get(f.destination) || { code: f.destination, name: f.name || f.destination, byOrigin: {}, options: {} };
      const opts = (d.options[origin.code] ||= []);
      const same = opts.findIndex((o) => airlineKey(o) === airlineKey(f));
      if (same < 0) opts.push(f); else if (f.price < opts[same].price) opts[same] = f;
      map.set(f.destination, d);
    }
  }
  for (const d of map.values()) {
    for (const [code, opts] of Object.entries(d.options)) {
      opts.sort((a, b) => a.price - b.price);
      d.byOrigin[code] = opts[0];
    }
    const prices = Object.values(d.byOrigin).map((f) => f.price);
    d.best = Math.min(...prices);
    if (fixedCode && d.byOrigin[fixedCode]) {
      // Con aeropuerto fijo todo se mide desde él: su precio y lo que cambia respecto al mejor de los demás.
      d.ref = d.byOrigin[fixedCode].price;
      const others = Object.entries(d.byOrigin).filter(([c]) => c !== fixedCode).map(([, f]) => f.price);
      d.diff = others.length ? Math.abs(d.ref - Math.min(...others)) : null;
    } else {
      d.ref = d.best;
      d.diff = prices.length > 1 ? Math.max(...prices) - d.best : null; // null: solo un origen
    }
  }
  return [...map.values()];
}

const SORTERS = {
  diff: (a, b) => (a.diff ?? Infinity) - (b.diff ?? Infinity) || a.ref - b.ref,
  cheap: (a, b) => a.ref - b.ref,
  name: (a, b) => a.name.localeCompare(b.name, 'es'),
};

let lastSearch = null;

function renderResults() {
  const { perOrigin, depart, ret } = lastSearch;
  const box = $('#results');
  const coverage = $('#coverage').value;
  const need = coverage === 'all' ? origins.length : Number(coverage);
  const errors = perOrigin.filter((r) => r.error);
  const fixedCode = perOrigin.some((r) => r.origin.code === fixed) ? fixed : null;
  const dests = groupByDestination(perOrigin, fixedCode)
    .filter((d) => (fixedCode ? !!d.byOrigin[fixedCode] : Object.keys(d.byOrigin).length >= Math.min(need, perOrigin.length)))
    .filter((d) => !$('#hide-single').checked || perOrigin.length < 2 || Object.keys(d.byOrigin).length >= 2)
    .sort(SORTERS[$('#sort').value] || SORTERS.diff);

  const flexTxt = Number($('#flex').value) ? ` (±${$('#flex').value} días)` : '';
  const head = `<h2 class="res-title">${dests.length} destinos · ${fmtDay(depart)}${ret ? ` → ${fmtDay(ret)}` : ' · solo ida'}${flexTxt}</h2>`;
  const errHtml = errors.map((r) => `<p class="error">${escapeHtml(r.origin.code)}: no se pudieron cargar precios (${escapeHtml(r.error)})</p>`).join('');
  if (!dests.length) {
    // Explica por qué no sale nada: sin datos o filtros demasiado estrictos.
    const perCount = perOrigin.filter((r) => !r.error).map((r) => `${escapeHtml(r.origin.code)}: ${r.flights.length}`).join(' · ');
    const total = groupByDestination(perOrigin, null).length;
    const tips = [];
    if (total) tips.push('Ningún destino coincide entre tus aeropuertos con estos filtros. Prueba a poner "Destinos: Todos" y desmarcar "Ocultar destinos con vuelo desde un solo aeropuerto".');
    if ($('#flex').value < 3) tips.push('Aumenta la flexibilidad de fechas para encontrar más vuelos.');
    if ($('#direct').checked) tips.push('Desmarca "Solo directos".');
    box.innerHTML = head + errHtml + `<div class="card empty"><p><strong>No hay destinos con estos filtros.</strong></p>
      <p class="note">Destinos encontrados por aeropuerto: ${perCount || 'ninguno'}</p>
      <ul>${tips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>`;
    return;
  }

  box.innerHTML = head + errHtml + dests.map((d, idx) => `
    <article class="dest card">
      <header class="dest-head" data-dest="${escapeHtml(d.code)}" role="button" tabindex="0" title="Ver detalles"><span class="rank">${idx + 1}</span><h3>${escapeHtml(d.name)} <small>${escapeHtml(d.code)}</small></h3><span class="from">${fixedCode ? escapeHtml(fixedCode) : 'desde'} <strong>${fmtPrice(d.ref)}</strong>${d.diff !== null ? `<br><span class="diff">${d.diff ? `diferencia ${fmtPrice(d.diff)}` : 'mismo precio'}</span>` : ''}</span></header>
      <ul>${origins.map((o, i) => [o, i]).sort(([a], [b]) => (b.code === fixedCode) - (a.code === fixedCode)).map(([o, i]) => {
        const f = d.byOrigin[o.code];
        if (!perOrigin.some((r) => r.origin.code === o.code)) return '';
        if (!f) return `<li class="none" style="--chip:${colorOf(i)}"><b>${escapeHtml(o.code)}</b><span>Sin vuelos</span></li>`;
        const info = [`${fmtDay(f.departure_at)} ${fmtTime(f.departure_at)}`.trim(), f.return_at && `vuelta ${fmtDay(f.return_at)}`, f.return_at ? `ida ${fmtStops(f.transfers).toLowerCase()} · vuelta ${fmtStops(f.return_transfers).toLowerCase()}` : fmtStops(f.transfers).toLowerCase(), AIRLINES[f.airline] || f.airline,
          d.options[o.code].length > 1 && `${d.options[o.code].length} aerolíneas`].filter(Boolean).join(' · ');
        return `<li class="${f.price === d.best ? 'best' : ''}${o.code === fixedCode ? ' is-fixed' : ''}" style="--chip:${colorOf(i)}">
          <b>${escapeHtml(o.code)}</b><span class="info">${escapeHtml(info)}</span><span class="price">${fmtPrice(f.price)}</span>
          <span class="actions">${bookLinks(f)}
          ${settings.proxyUrl ? `<button class="live-btn" data-o="${escapeHtml(o.code)}" data-d="${escapeHtml(d.code)}">Confirmar en Google Flights</button>` : ''}</span>
          <div class="live hidden"></div>
        </li>`;
      }).join('')}</ul>
    </article>`).join('');

  const byCode = new Map(dests.map((d) => [d.code, d]));
  box.querySelectorAll('.dest').forEach((card) => {
    const d = byCode.get(card.querySelector('.dest-head').dataset.dest);
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return; // enlaces y botones hacen lo suyo
      openDetail(d, perOrigin.map((r) => r.origin), fixedCode, depart, ret);
    });
    card.querySelector('.dest-head').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openDetail(d, perOrigin.map((r) => r.origin), fixedCode, depart, ret);
    });
  });

  box.querySelectorAll('.live-btn').forEach((btn) => {
    btn.onclick = async () => {
      const out = btn.closest('li').querySelector('.live');
      out.classList.remove('hidden');
      out.textContent = 'Consultando Google Flights…';
      try {
        const live = await getLive(btn.dataset.o, btn.dataset.d, depart, ret);
        out.innerHTML = live
          ? `En directo: <strong>${fmtPrice(live.price)}</strong>${live.airline ? ` · ${escapeHtml(live.airline)}` : ''}${live.link ? ` · <a href="${escapeHtml(live.link)}" target="_blank" rel="noopener">abrir</a>` : ''}`
          : 'Google Flights no encuentra vuelos esas fechas.';
      } catch (err) { out.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`; }
    };
  });
}

// Enlaces de reserva; con ida y vuelta por separado son dos billetes.
function bookLinks(f) {
  const a = (href, text) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${text}</a>`;
  if (f.return_link) return [f.link && a(f.link, 'Reservar ida'), a(f.return_link, 'Reservar vuelta')].filter(Boolean).join(' · ');
  const site = f.link?.includes('ryanair.com') ? 'Ryanair' : f.link?.includes('wizzair.com') ? 'Wizz Air' : 'Aviasales';
  return f.link ? a(f.link, `Reservar en ${site}`) : '';
}

// Ficha de un destino: compara el vuelo desde cada aeropuerto de origen.
function openDetail(d, searched, fixedCode, depart, ret) {
  const cols = searched
    .map((o) => ({ o, i: origins.findIndex((x) => x.code === o.code), f: d.byOrigin[o.code] }))
    .sort((a, b) => (b.o.code === fixedCode) - (a.o.code === fixedCode) || (a.f ? a.f.price : Infinity) - (b.f ? b.f.price : Infinity));
  const when = (iso) => (iso ? `${fmtDay(iso)}${fmtTime(iso) ? ` · ${fmtTime(iso)}` : ''}` : '—');
  const rows = [
    ['Precio', (f) => `<strong>${fmtPrice(f.price)}</strong>${f.price_back != null ? `<br><small>ida ${fmtPrice(f.price_out)} + vuelta ${fmtPrice(f.price_back)}</small>` : ''}`, true],
    ['Aerolínea', (f) => escapeHtml(airlineName(f.airline))],
    ['Vuelo', (f) => escapeHtml(f.flight_number ? `${f.airline || ''} ${f.flight_number}` : '—')],
    ['Ruta', (f) => escapeHtml(`${f.origin_airport || '?'} → ${f.destination_airport || d.code}`)],
    ['Salida ida', (f) => when(f.departure_at)],
    ['Duración ida', (f) => fmtDuration(f.duration_to)],
    ['Escalas ida', (f) => fmtStops(f.transfers)],
    ...(ret ? [
      ['Salida vuelta', (f) => when(f.return_at)],
      ['Aerolínea vuelta', (f) => escapeHtml(airlineName(f.return_airline || f.airline))],
      ['Vuelo vuelta', (f) => escapeHtml(f.return_flight_number ? `${f.return_airline || ''} ${f.return_flight_number}` : '—')],
      ['Duración vuelta', (f) => fmtDuration(f.duration_back)],
      ['Escalas vuelta', (f) => fmtStops(f.return_transfers)],
    ] : []),
    ['Reservar', (f) => bookLinks(f) || '—'],
  ];
  const head = `<tr><th></th>${cols.map(({ o, i }) => `<th style="--chip:${colorOf(i)}" class="${o.code === fixedCode ? 'is-fixed' : ''}">${escapeHtml(o.code)}<small>${escapeHtml(o.name)}</small></th>`).join('')}</tr>`;
  const body = rows.map(([label, cell, highlight]) => `<tr><th>${label}</th>${cols.map(({ f }) => {
    if (!f) return '<td class="none">—</td>';
    return `<td class="${highlight && f.price === d.best ? 'best' : ''}">${cell(f)}</td>`;
  }).join('')}</tr>`).join('');

  // Todas las aerolíneas que vuelan a este destino desde cada aeropuerto, de más barata a más cara.
  const optionList = cols.filter(({ f }) => f).map(({ o, i }) => {
    const opts = d.options[o.code];
    return `<section class="opts" style="--chip:${colorOf(i)}"><h3>${escapeHtml(o.code)} <small>${escapeHtml(o.name)} · ${opts.length} ${opts.length > 1 ? 'aerolíneas' : 'aerolínea'}</small></h3>
      <ul>${opts.map((f, n) => {
        const airline = f.return_airline && f.return_airline !== f.airline
          ? `${AIRLINES[f.airline] || f.airline} + ${AIRLINES[f.return_airline] || f.return_airline}` : (AIRLINES[f.airline] || f.airline || '—');
        const info = [when(f.departure_at), f.return_at && `vuelta ${when(f.return_at)}`,
          f.return_at ? `ida ${fmtStops(f.transfers).toLowerCase()} · vuelta ${fmtStops(f.return_transfers).toLowerCase()}` : fmtStops(f.transfers).toLowerCase()].filter(Boolean).join(' · ');
        return `<li class="${n === 0 ? 'best' : ''}"><b>${escapeHtml(airline)}</b><span class="price">${fmtPrice(f.price)}</span>
          <span class="info">${escapeHtml(info)}</span><span class="actions">${bookLinks(f)}</span></li>`;
      }).join('')}</ul></section>`;
  }).join('');

  const dlg = $('#detail');
  dlg.querySelector('.detail-body').innerHTML = `
    <h2>${escapeHtml(d.name)} <small>${escapeHtml(d.code)}</small></h2>
    <p class="note">${fmtDay(depart)}${ret ? ` → ${fmtDay(ret)}` : ' · solo ida'}. Cada columna es el vuelo más barato desde ese aeropuerto.</p>
    <div class="table-wrap"><table class="detail-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    <h2 class="opts-title">Opciones por aerolínea</h2>${optionList}`;
  dlg.showModal();
}

async function onSearch(e) {
  e.preventDefault();
  const depart = $('#depart').value;
  const ret = $('#oneway').checked ? null : $('#return').value || null;
  if (ret && ret < depart) { $('#mode-note').textContent = 'La vuelta tiene que ser después de la ida.'; return; }
  if (!origins.length) { $('#mode-note').textContent = 'Añade al menos un aeropuerto de origen.'; return; }
  updateModeNote();
  const direct = $('#direct').checked;
  $('#results').innerHTML = '<p class="note">Buscando destinos…</p>';
  const perOrigin = await Promise.all(origins.map(async (origin) => {
    try { return { origin, flights: await getCheapest(origin.code, depart, ret, direct, $('#flex').value) }; }
    catch (err) { return { origin, flights: [], error: err.message }; }
  }));
  lastSearch = { perOrigin, depart, ret };
  renderResults();
}

function updateModeNote() {
  $('#mode-note').textContent = settings.proxyUrl
    ? 'Precios de Ryanair y Wizz Air (en directo) y Travelpayouts (búsquedas recientes); pueden variar al reservar.'
    : 'Modo demo: los precios son inventados hasta que configures el proxy en Ajustes.';
}

function init() {
  const d = new Date(); d.setDate(d.getDate() + 30);
  const r = new Date(d); r.setDate(r.getDate() + 4);
  $('#depart').value = d.toISOString().slice(0, 10);
  $('#return').value = r.toISOString().slice(0, 10);
  renderOrigins();
  updateFixedUi();
  updateModeNote();
  wireAutocomplete($('#origin-input'), $('#origin-suggest'), addOrigin);

  $('#oneway').addEventListener('change', (e) => { $('#return').disabled = e.target.checked; });
  $('#coverage').addEventListener('change', () => lastSearch && renderResults());
  $('#sort').addEventListener('change', () => lastSearch && renderResults());
  $('#hide-single').addEventListener('change', () => lastSearch && renderResults());
  $('#add-origin').addEventListener('submit', (e) => {
    e.preventDefault();
    // Sin elegir de la lista: acepta un código de 3 letras o la primera sugerencia.
    const text = $('#origin-input').value;
    const known = searchAirports(text)[0];
    const p = parsePlace(text);
    addOrigin(known || (p && { code: p.code, city: p.name }));
    $('#origin-input').value = '';
  });
  $('#search').addEventListener('submit', onSearch);

  const dlg = $('#settings');
  $('#btn-settings').onclick = () => {
    $('#proxy-url').value = settings.proxyUrl;
    $('#currency').value = settings.currency;
    dlg.showModal();
  };
  $('#save-settings').onclick = () => {
    settings = { proxyUrl: $('#proxy-url').value.trim(), currency: $('#currency').value };
    store.set('settings', settings);
    updateModeNote();
  };

  // Tocar fuera de la ficha la cierra.
  $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') e.target.close(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
