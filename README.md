# Sentieri – prototipo
Contenitore dei percorsi del Gruppo di Cammino di Rocca d'Arazzo (AT). 
Sono prevalentemente localizzati nel territorio di Rocca. 
Le schede dei singoli percorsi sono arricchite di informazioni teniche (difficoltà, lunghezza, durata) con la possibilità di scaricare il gpx


Requisiti: Node.js 18+.

    npm install
    npm run dev       # sviluppo: http://localhost:5173
    npm run build     # produce la cartella dist/ da pubblicare

I dati stanno in public/data (routes.json, pois.geojson, gpx/).
La geolocalizzazione richiede HTTPS (localhost è ammesso).
