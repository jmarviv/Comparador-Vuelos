// Cloudflare Worker: guarda las claves de las APIs y añade CORS para la PWA.
// Secretos: TRAVELPAYOUTS_TOKEN (destinos más baratos) y SERPAPI_KEY (precio en directo).
// Variable opcional: ALLOWED_ORIGIN.

const TP_PRICES = 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates';
const TP_CITIES = 'https://api.travelpayouts.com/data/en/cities.json';
const PLACES = 'https://autocomplete.travelpayouts.com/places2';

const TP_AIRPORTS = 'https://api.travelpayouts.com/data/en/airports.json';
const RYANAIR = 'https://www.ryanair.com/api/farfnd/v4';

let cityNames = null; // código IATA de ciudad -> nombre en español
let airportCity = null; // código IATA de aeropuerto -> código de ciudad (STN -> LON)

async function getAirportCities() {
  if (airportCity) return airportCity;
  const res = await fetch(TP_AIRPORTS, { cf: { cacheTtl: 86400, cacheEverything: true } });
  const list = res.ok ? await res.json() : [];
  airportCity = Object.fromEntries(list.map((a) => [a.code, a.city_code || a.code]));
  return airportCity;
}

// Ryanair: API pública de su buscador de tarifas (no oficial). Precios reales de todos sus destinos
// desde un aeropuerto, con un rango de fechas de ida y, opcionalmente, de vuelta.
async function ryanairFares({ origin, departFrom, departTo, returnFrom, returnTo, currency }) {
  const q = new URL(`${RYANAIR}/${returnFrom ? 'roundTripFares' : 'oneWayFares'}`);
  const params = {
    departureAirportIataCode: origin, outboundDepartureDateFrom: departFrom, outboundDepartureDateTo: departTo,
    currency: currency.toUpperCase(), market: 'es-es', language: 'es',
  };
  if (returnFrom) Object.assign(params, { inboundDepartureDateFrom: returnFrom, inboundDepartureDateTo: returnTo });
  q.search = new URLSearchParams(params);
  const res = await fetch(q, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (comparador-vuelos)' } });
  if (!res.ok) throw new Error(`ryanair ${res.status}`);
  return (await res.json()).fares || [];
}

function ryanairLink(out, back) {
  const p = new URLSearchParams({
    adults: '1', teens: '0', children: '0', infants: '0',
    dateOut: out.departureDate.slice(0, 10), dateIn: back ? back.departureDate.slice(0, 10) : '',
    isReturn: back ? 'true' : 'false', originIata: out.departureAirport.iataCode, destinationIata: out.arrivalAirport.iataCode,
  });
  return `https://www.ryanair.com/es/es/trip/flights/select?${p}`;
}

const minutesBetween = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);

async function getCityNames() {
  if (cityNames) return cityNames;
  const res = await fetch(TP_CITIES, { cf: { cacheTtl: 86400, cacheEverything: true } });
  const list = res.ok ? await res.json() : [];
  cityNames = Object.fromEntries(list.map((c) => [c.code, c.name_translations?.es || c.name || c.code]));
  return cityNames;
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' },
    });
    const iata = (v) => /^[A-Z]{3}$/i.test(v || '') ? v.toUpperCase() : null;
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

    if (url.pathname === '/cheapest') {
      // Vuelo más barato a cada destino desde un origen, para unas fechas con flexibilidad de ± días.
      // La caché de Travelpayouts tiene huecos para días concretos, así que se mira cada día de la
      // ventana de ida y, para la vuelta, el mes entero de cada destino filtrando por la ventana.
      const origin = iata(url.searchParams.get('origin'));
      const depart = url.searchParams.get('depart');
      const ret = url.searchParams.get('return');
      const flex = Math.min(3, Math.max(0, Number(url.searchParams.get('flex')) || 0));
      if (!origin || !isDate(depart) || (ret && !isDate(ret))) return json({ error: 'parámetros inválidos' }, 400);

      const common = {
        sorting: 'price', one_way: 'true', market: 'es',
        currency: url.searchParams.get('currency') || 'eur',
        direct: url.searchParams.get('direct') === '1' ? 'true' : 'false',
      };
      const tp = async (params) => {
        const q = new URL(TP_PRICES);
        q.search = new URLSearchParams({ ...common, ...params });
        const res = await fetch(q, { headers: { 'X-Access-Token': env.TRAVELPAYOUTS_TOKEN, 'Accept-Encoding': 'gzip' } });
        if (!res.ok) throw new Error(`travelpayouts ${res.status}`);
        return (await res.json()).data || [];
      };
      const shift = (iso, days) => {
        const d = new Date(`${iso}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      };
      const window = (iso) => Array.from({ length: 2 * flex + 1 }, (_, i) => shift(iso, i - flex));

      // Ida: el más barato a cada destino entre todos los días de la ventana.
      let names;
      const best = new Map();
      try {
        const [days, n] = await Promise.all([
          Promise.all(window(depart).map((d) => tp({ origin, departure_at: d, unique: 'true', limit: '1000' }))),
          getCityNames(),
        ]);
        names = n;
        for (const t of days.flat()) {
          const prev = best.get(t.destination);
          if (!prev || t.price < prev.price) best.set(t.destination, t);
        }
      } catch (err) {
        return json({ error: err.message }, 502);
      }
      // Cloudflare gratis permite 50 peticiones por llamada: las vueltas se buscan para los más baratos.
      const outbound = [...best.values()].sort((a, b) => a.price - b.price).slice(0, ret ? 50 - 2 * flex - 5 : undefined);

      let backs = [];
      if (ret) {
        const okDays = new Set(window(ret));
        backs = await Promise.all(outbound.map((t) => tp({ origin: t.destination, destination: origin, departure_at: ret.slice(0, 7), limit: '1000' })
          .then((list) => list
            .filter((b) => okDays.has(b.departure_at.slice(0, 10)) && b.departure_at.slice(0, 10) > t.departure_at.slice(0, 10))
            .reduce((a, b) => (!a || b.price < a.price ? b : a), null))
          .catch(() => null)));
      }

      const link = (t) => (t?.link ? `https://www.aviasales.com${t.link}` : null);
      const flights = [];
      outbound.forEach((t, i) => {
        const back = ret ? backs[i] : null;
        if (ret && !back) return; // sin vuelta en la ventana: no sirve para el viaje
        flights.push({
          destination: t.destination, name: names[t.destination] || t.destination,
          price: t.price + (back ? back.price : 0), airline: t.airline, transfers: t.transfers,
          departure_at: t.departure_at, return_at: back ? back.departure_at : null,
          flight_number: t.flight_number, origin_airport: t.origin_airport, destination_airport: t.destination_airport,
          duration_to: t.duration_to ?? t.duration, duration_back: back ? (back.duration_to ?? back.duration) : null,
          return_transfers: back ? back.transfers : null,
          return_airline: back ? back.airline : null, return_flight_number: back ? back.flight_number : null,
          price_out: t.price, price_back: back ? back.price : null,
          link: link(t), return_link: link(back),
        });
      });
      // Ryanair: se pide aparte y se mezcla por ciudad, quedándose con el precio más barato.
      const sources = { travelpayouts: flights.length, ryanair: 0 };
      try {
        const [fares, cities] = await Promise.all([
          ryanairFares({
            origin, departFrom: shift(depart, -flex), departTo: shift(depart, flex),
            returnFrom: ret ? shift(ret, -flex) : null, returnTo: ret ? shift(ret, flex) : null,
            currency: common.currency,
          }),
          getAirportCities(),
        ]);
        const byCity = new Map(flights.map((f) => [f.destination, f]));
        for (const fare of fares) {
          const out = fare.outbound;
          const back = fare.inbound || null;
          if (!out?.price || (ret && !back?.price)) continue;
          const airport = out.arrivalAirport.iataCode;
          const city = cities[airport] || airport;
          const price = Math.round(fare.summary?.price?.value ?? (out.price.value + (back ? back.price.value : 0)));
          const prev = byCity.get(city);
          if (prev && prev.price <= price) continue;
          sources.ryanair += 1;
          byCity.set(city, {
            destination: city, name: names[city] || out.arrivalAirport.city?.name || out.arrivalAirport.name,
            price, airline: 'FR', transfers: 0,
            departure_at: out.departureDate, return_at: back ? back.departureDate : null,
            flight_number: out.flightNumber?.replace(/^FR\s*/, ''), origin_airport: origin, destination_airport: airport,
            duration_to: minutesBetween(out.departureDate, out.arrivalDate),
            duration_back: back ? minutesBetween(back.departureDate, back.arrivalDate) : null,
            return_transfers: back ? 0 : null, return_airline: back ? 'FR' : null,
            return_flight_number: back?.flightNumber?.replace(/^FR\s*/, ''),
            price_out: Math.round(out.price.value), price_back: back ? Math.round(back.price.value) : null,
            link: ryanairLink(out, back), return_link: null, source: 'ryanair',
          });
        }
        flights.length = 0;
        flights.push(...byCity.values());
      } catch (err) {
        sources.ryanair_error = err.message;
      }

      flights.sort((a, b) => a.price - b.price);
      return json({ flights, sources });
    }

    if (url.pathname === '/live') {
      // Precio en directo de Google Flights (SerpApi) para un origen, destino y fechas.
      const origin = iata(url.searchParams.get('origin'));
      const destination = iata(url.searchParams.get('destination'));
      const date = url.searchParams.get('date');
      const ret = url.searchParams.get('return');
      if (!origin || !destination || !isDate(date) || (ret && !isDate(ret))) return json({ error: 'parámetros inválidos' }, 400);

      const params = {
        engine: 'google_flights', departure_id: origin, arrival_id: destination, outbound_date: date,
        type: ret ? '1' : '2', currency: (url.searchParams.get('currency') || 'EUR').toUpperCase(), hl: 'es', gl: 'es',
        api_key: env.SERPAPI_KEY,
      };
      if (ret) params.return_date = ret;
      const q = new URL('https://serpapi.com/search.json');
      q.search = new URLSearchParams(params);
      const res = await fetch(q);
      if (!res.ok) return json({ error: `serpapi ${res.status}` }, 502);
      const data = await res.json();
      const flights = [...(data.best_flights || []), ...(data.other_flights || [])].filter((f) => f.price);
      if (!flights.length) return json({ live: null });
      const best = flights.reduce((a, b) => (b.price < a.price ? b : a));
      return json({
        live: {
          price: best.price,
          airline: best.flights?.[0]?.airline,
          departure: best.flights?.[0]?.departure_airport?.time,
          transfers: (best.flights?.length || 1) - 1,
          link: data.search_metadata?.google_flights_url || null,
        },
      });
    }

    if (url.pathname === '/places') {
      const term = (url.searchParams.get('term') || '').slice(0, 40);
      const q = new URL(PLACES);
      q.searchParams.set('term', term);
      q.searchParams.set('locale', 'es');
      q.searchParams.append('types[]', 'city');
      q.searchParams.append('types[]', 'airport');
      const res = await fetch(q);
      if (!res.ok) return json({ places: [] });
      const places = (await res.json()).slice(0, 8).map((p) => ({ code: p.code, name: p.name, country: p.country_name }));
      return json({ places });
    }

    return json({ error: 'no encontrado' }, 404);
  },
};
