// Cloudflare Worker: guarda las claves de las APIs y añade CORS para la PWA.
// Secretos: TRAVELPAYOUTS_TOKEN (destinos más baratos) y SERPAPI_KEY (precio en directo).
// Variable opcional: ALLOWED_ORIGIN.

const TP_PRICES = 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates';
const TP_CITIES = 'https://api.travelpayouts.com/data/en/cities.json';
const PLACES = 'https://autocomplete.travelpayouts.com/places2';

let cityNames = null; // código IATA de ciudad -> nombre en español

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
      // Vuelo más barato a cada destino desde un origen, para unas fechas.
      // Ida y vuelta: la caché de Travelpayouts casi no tiene pares de fechas exactos, así que se
      // busca la ida a todos los destinos y luego la vuelta de cada destino, y se suman.
      const origin = iata(url.searchParams.get('origin'));
      const depart = url.searchParams.get('depart');
      const ret = url.searchParams.get('return');
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

      let outbound;
      let names;
      try {
        [outbound, names] = await Promise.all([
          tp({ origin, departure_at: depart, unique: 'true', limit: '1000' }),
          getCityNames(),
        ]);
      } catch (err) {
        return json({ error: err.message }, 502);
      }

      // Vuelta más barata de cada destino al origen ese día (null si no hay).
      const backs = ret
        ? await Promise.all(outbound.map((t) => tp({ origin: t.destination, destination: origin, departure_at: ret, limit: '1' })
          .then((d) => d[0] || null).catch(() => null)))
        : [];

      const link = (t) => (t?.link ? `https://www.aviasales.com${t.link}` : null);
      const flights = [];
      outbound.forEach((t, i) => {
        const back = ret ? backs[i] : null;
        if (ret && !back) return; // sin vuelta ese día: no sirve para el viaje
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
      flights.sort((a, b) => a.price - b.price);
      return json({ flights });
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
