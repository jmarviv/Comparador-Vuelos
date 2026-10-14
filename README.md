# Comparador de vuelos

Web instalable en el móvil (PWA). Eliges aeropuertos de origen y fechas, ida y vuelta o solo ida, y te lista los destinos más baratos con el precio desde cada origen.

- `app/`: la web (HTML/CSS/JS sin dependencias). Se publica en GitHub Pages con `.github/workflows/pages.yml`.
- `app/config.js`: dirección del proxy de precios. Si está vacía, la app funciona en modo demo con precios inventados.
- `proxy/`: Cloudflare Worker que guarda las claves de las APIs y las llama por la app (`/cheapest`, `/live`, `/places`).

## Funciones

- Ordenar por menor diferencia de precio entre orígenes, por más barato o por nombre.
- Aeropuerto fijo (📌): muestra todos sus destinos y ordena según su precio.
- Ficha de cada destino con el vuelo desde cada aeropuerto: horarios, duración, escalas y aerolínea.
- Filtros: solo directos (ida y vuelta) y ocultar destinos con vuelo desde un solo aeropuerto.
- Autocompletado local de aeropuertos (`app/airports.js`, datos de OurAirports, dominio público).

## Probar en local

`cd app && python3 -m http.server 8000` y abrir http://localhost:8000.

## Precios reales

Travelpayouts Data API (`aviasales/v3/prices_for_dates` sin destino, `unique=true`) para los destinos, y Google Flights vía SerpApi para confirmar en directo.

1. Crear el Worker en Cloudflare con `proxy/worker.js`.
2. Añadir los secretos `TRAVELPAYOUTS_TOKEN` y `SERPAPI_KEY` en el Worker. Nunca van en el repositorio.
3. Poner la dirección del Worker en `app/config.js`.
