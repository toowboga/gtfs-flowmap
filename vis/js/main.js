// Main Visualization Script

// 1. Initialisiere Leaflet Map (Dark Mode Theme)
const map = L.map('map', {
    center: [51.165691, 10.451526], // Mitte Deutschland
    zoom: 6,
    zoomControl: false // Wir können das UI später anpassen
});

// CartoDB Map
let currentThemeUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const cartoLayer = L.tileLayer(currentThemeUrl, {
	attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
	subdomains: 'abcd',
	maxZoom: 20
}).addTo(map);

// 2. D3 Setup für SVG-Overlay
map.createPane('voronoiPane');
map.getPane('voronoiPane').style.zIndex = 350; // Unter dem overlayPane (400)

L.svg().addTo(map);
const overlay = d3.select(map.getPanes().overlayPane);
const svg = overlay.select('svg');
const g = svg.append('g').attr('class', 'leaflet-zoom-hide');

/*
// marker für pfeile
const defs = svg.append("defs");

// marker width
defs.append("marker")
    .attr("id", "arrowhead")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 10)
    .attr("refY", 0)
    .attr("markerWidth", 8)
    .attr("markerHeight", 8)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", "#ff4757");
*/

// State
let nodesData = [];
let edgesData = [];
let regionsData = null;

// 3. Daten laden und visualisieren
Promise.all([
    d3.json('../data/processed/nodes.json'),
    d3.json('../data/processed/edges.json'),
    d3.json('../data/processed/regions.geojson'),
    d3.json('../data/processed/agencies.json')
]).then(([nodes, edges, regions, agencies]) => {
    nodesData = nodes;
    edgesData = edges;
    regionsData = regions;

    console.log(`Geladen: ${nodes.length} Nodes, ${edges.length} Edges, ${regions.features.length} Regionen und ${agencies.length} Agencies`);

    // UI Event Listener
    const radiusMap = [0, 5, 10, 25, 50];
    let currentRadius = radiusMap[document.getElementById('cluster-radius').value];
    let currentThreshold = parseInt(document.getElementById('threshold').value);
    let selectedAgencies = new Set();
    const container = document.getElementById('agency-filter-container');

    // Wir iterieren über das geladene JSON-Dictionary
    Object.entries(agencies).forEach(([id, name]) => {
        selectedAgencies.add(Number(id)); // Standardmäßig alle aktivieren
        let chip = document.createElement('div');
        chip.className = 'agency-chip active';
        chip.innerText = name;
        chip.dataset.id = id;

        // Klick-Logik zum An/Ausschalten
        chip.addEventListener('click', function() {
            let numericId = Number(this.dataset.id);
            if (this.classList.contains('active')) {
                this.classList.remove('active');
                selectedAgencies.delete(numericId);
            } else {
                this.classList.add('active');
                selectedAgencies.add(numericId);
            }
            updateView(); // Löst das Neu-Zeichnen aus!
        });

        container.appendChild(chip);
    });

    document.getElementById('cluster-radius').addEventListener('input', (e) => {
        currentRadius = radiusMap[e.target.value];
        document.getElementById('radius-val').innerText = currentRadius === 0 ? 'Aus' : currentRadius + ' km';
        updateView();
    });

    document.getElementById('threshold').addEventListener('input', (e) => {
        currentThreshold = parseInt(e.target.value);
        document.getElementById('threshold-val').innerText = currentThreshold;
        updateView();
    });

    // Theme Toggle (Radio Group)
    const themeRadios = document.querySelectorAll('input[name="theme"]');
    const themeChoices = document.querySelectorAll('.RadioGroup__choice');

    function applyTheme(theme) {
        if (theme === 'system') {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            theme = prefersDark ? 'dark' : 'light';
        }
        
        if (theme === 'dark') {
            document.body.classList.add('theme-dark');
            cartoLayer.setUrl('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png');
        } else {
            document.body.classList.remove('theme-dark');
            cartoLayer.setUrl('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png');
        }
        
        updateView();
    }

    themeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            themeChoices.forEach(c => c.classList.remove('active'));
            e.target.closest('.RadioGroup__choice').classList.add('active');
            applyTheme(e.target.value);
        });
    });

    // Listen for system preference changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const selected = document.querySelector('input[name="theme"]:checked').value;
        if (selected === 'system') {
            applyTheme('system');
        }
    });

    // Voronoi Toggle
    document.getElementById('voronoi-toggle').addEventListener('change', () => {
        updateView();
    });

    let currentGeoJsonLayer = null;

    // Funktion für das Rendern der aktuellen Ebene
    function updateView() {
        console.log(`Update View: Radius=${currentRadius}, Threshold=${currentThreshold}`);

        // 1. Voronoi Polygone filtern & zeichnen (Leaflet)
        if (currentGeoJsonLayer) {
            map.removeLayer(currentGeoJsonLayer);
        }
        
        const showVoronoi = document.getElementById('voronoi-toggle').checked;
        if (showVoronoi && currentRadius > 0) {
            let filteredRegions = {
                type: "FeatureCollection",
                features: regionsData.features.filter(f => f.properties.radius === currentRadius)
            };

            const isDark = document.body.classList.contains('theme-dark');

            currentGeoJsonLayer = L.geoJSON(filteredRegions, {
                pane: 'voronoiPane',
                style: {
                    color: isDark ? '#555' : '#bbb',
                    weight: 1,
                    fillColor: isDark ? '#333' : '#f0f0f0',
                    fillOpacity: isDark ? 0.2 : 0.4
                }
            }).addTo(map);
        }

        // 2. Kategoriale Filter anwenden (Radius & Agency)
        let filteredEdgesRaw = edgesData.filter(e => e.radius === currentRadius 
                                            && selectedAgencies.has(e.agency_id));

        // Kanten ZUERST aggregieren!
        // Wir fassen alle Fahrten (verschiedene Tageszeiten/Agencies) für eine Strecke zusammen.
        const aggregatedEdgesMap = new Map();
        filteredEdgesRaw.forEach(e => {
            const key = e.origin_id + "-" + e.dest_id;
            if (!aggregatedEdgesMap.has(key)) {
                aggregatedEdgesMap.set(key, { ...e, daily_trips: 0 }); // Kopie erstellen
            }
            aggregatedEdgesMap.get(key).daily_trips += e.daily_trips;
        });

        // 3. Schwellenwert (Threshold) auf die AGGREGIERTEN Kanten anwenden
        // Erst jetzt prüfen, ob die Gesamtzahl der Fahrten >= Threshold ist.
        let filteredEdges = Array.from(aggregatedEdgesMap.values())
            .filter(e => e.daily_trips >= currentThreshold);

        // Nodes filtern (nur solche, die mit sichtbaren Edges verbunden sind)
        const validNodeIds = new Set();
        filteredEdges.forEach(e => {
            validNodeIds.add(e.origin_id);
            validNodeIds.add(e.dest_id);
        });
        
        let filteredNodes = nodesData.filter(n => n.radius === currentRadius && validNodeIds.has(n.id));

        // Zoom-Abhängige Skalierung (Pfeile generell noch etwas dünner gemacht)
        const currentZoom = map.getZoom();
        const zoomFactor = Math.pow(1.5, currentZoom - 6); // Basis-Zoom 6
        
        const maxWidth = Math.min(30, 8 * zoomFactor);
        const minWidth = Math.max(0.5, 1 * zoomFactor);
        
        const nodeMaxWidth = Math.min(25, 8 * zoomFactor);
        const nodeMinWidth = Math.max(1.5, 1.5 * zoomFactor);

        // Absolute Skalierung: Maximum über alle Daten (ungefiltert).
        // Dadurch schrumpfen Flüsse nicht, wenn man andere herausfiltert.
        const allAgg = new Map();
        edgesData.forEach(e => {
            const key = e.origin_id + "-" + e.dest_id;
            allAgg.set(key, (allAgg.get(key) || 0) + e.daily_trips);
        });
        const absoluteMaxTrips = d3.max(Array.from(allAgg.values())) || 10;
        const absoluteMaxWeight = d3.max(nodesData, d => d.weight) || 100;

        // function for scaling
        const widthScale = d3.scaleSqrt()
            .domain([1, absoluteMaxTrips])
            .range([minWidth, maxWidth]);

        const nodeScale = d3.scaleSqrt()
            .domain([1, absoluteMaxWeight])
            .range([nodeMinWidth, nodeMaxWidth]);

        // Hilfsfunktion: Lat/Lon nach SVG-Koordinaten umrechnen
        function projectPoint(x, y) {
            let point = map.latLngToLayerPoint(new L.LatLng(y, x));
            return [point.x, point.y];
        }

        // Node-Lookup für schnelle Koordinatenfindung
        const nodeLookup = new Map();
        filteredNodes.forEach(n => nodeLookup.set(n.id, n));

        // edge lookup
        const edgeLookup = new Set(
            filteredEdges.map( e => `${e.origin_id}-${e.dest_id}`)  
        );

        // arrow creation
        function createArrowPath(d) {
            // determine origin and dest points
            const origin = nodeLookup.get(d.origin_id);
            const dest = nodeLookup.get(d.dest_id);

            if(!origin || !dest) return "";

            let [orX, orY] = projectPoint(origin.lon, origin.lat);
            let [destX, destY] = projectPoint(dest.lon, dest.lat);

            const dx = destX - orX;
            const dy = destY - orY;

            // length between points
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1) return "";

            // direction vectors
            const ux = dx / len;
            const uy = dy / len;

            // senkrechte vektoren
            const nx = -uy;
            const ny = ux;

            // width values
            const width  = widthScale(d.daily_trips);

            // arrow "hook" values
            const arrowLength = width * 2;  // length of arrow "hook"
            const arrowWidth = width * 1.5; // width of arrow wing

            // Radius des Zielknotens abziehen, damit der Pfeil nicht im Knoten steckt
            const destRadius = nodeScale(dest.weight || 0) + 2; // + 2px Puffer
            
            // Verkürze die Ziellinie um den Zielradius
            let tipX = destX - destRadius * ux;
            let tipY = destY - destRadius * uy;

            // Radius des Startknotens abziehen, damit der Pfeil nicht im Knoten steckt
            const originRadius = nodeScale(origin.weight || 0) + 2;

            // Verkürze die Linie um den Startradius
            let baseX = orX + originRadius * ux;
            let baseY = orY + originRadius * uy;

            // Fester Gap (Abstand von der echten Mittellinie)
            // Fester Gap ist "besser" als ein dynamischer, da die Flüsse sonst
            // bei großer Dicke geografisch zu weit von der echten Route abweichen.
            const reverse = edgeLookup.has(`${d.dest_id}-${d.origin_id}`);
            const gap = reverse ? 1.5 : 0; 
            
            // Die äußere Kante des Halbpfeils
            const outer = gap + width;

            // Verhindern, dass der Pfeil "rückwärts" gezeichnet wird, falls Knoten zu nah sind
            const newLen = Math.sqrt(Math.pow(tipX - baseX, 2) + Math.pow(tipY - baseY, 2));
            if (newLen < arrowLength) return "";

            // Halbpfeil-Geometrie (wird nur auf die "rechte" Seite der Mittellinie gezeichnet)
            // 1. Innere Basis (auf der Mittellinie + gap)
            const p1 = [
                baseX + gap * nx,
                baseY + gap * ny
            ];

            // 2. Äußere Basis
            const p2 = [
                baseX + outer * nx,
                baseY + outer * ny
            ];

            // 3. Äußere Kante am Beginn des Pfeilkopfes
            const p3 = [
                tipX - arrowLength * ux + outer * nx,
                tipY - arrowLength * uy + outer * ny
            ];

            // 4. Äußerste Spitze des Pfeilkopfes (der nach außen stehende "Flügel")
            const p4 = [
                tipX - arrowLength * ux + (outer + arrowWidth) * nx,
                tipY - arrowLength * uy + (outer + arrowWidth) * ny
            ];

            // 5. Eigentliche Pfeilspitze (endet exakt auf der inneren Linie)
            const p5 = [
                tipX + gap * nx,
                tipY + gap * ny
            ];

            return `
                M ${p1[0]} ${p1[1]}
                L ${p2[0]} ${p2[1]}
                L ${p3[0]} ${p3[1]}
                L ${p4[0]} ${p4[1]}
                L ${p5[0]} ${p5[1]}
                Z
            `;
        }

        // 3. Vorschau-Rendering mit D3

        // Kanten zeichnen
        /*
        const lines = g.selectAll(".preview-edge")
            .data(filteredEdges, d => d.origin_id + "-" + d.dest_id);

        lines.join(
            enter => enter.append("line")
                .attr("class", "preview-edge")
                .attr("stroke", "#ff4757")
                .attr("stroke-opacity", 0.3)
                .attr("stroke-width", d => Math.max(1, Math.log10(d.daily_trips)))
                .attr("marker-end","url(#arrowhead)"),
            update => update,
            exit => exit.remove()
        )
        .attr("x1", d => projectPoint(nodeLookup.get(d.origin_id)?.lon, nodeLookup.get(d.origin_id)?.lat)[0] || 0)
        .attr("y1", d => projectPoint(nodeLookup.get(d.origin_id)?.lon, nodeLookup.get(d.origin_id)?.lat)[1] || 0)
        .attr("x2", d => projectPoint(nodeLookup.get(d.dest_id)?.lon, nodeLookup.get(d.dest_id)?.lat)[0] || 0)
        .attr("y2", d => projectPoint(nodeLookup.get(d.dest_id)?.lon, nodeLookup.get(d.dest_id)?.lat)[1] || 0);
        */


        // Pfeile zeichnen
        const paths = g.selectAll(".preview-edge")
            .data(filteredEdges, d => d.origin_id + "-" + d.dest_id);

        paths.join(
            enter => enter.append("path")
                .attr("class", "preview-edge")
                .attr("fill", "var(--edge-fill)")
                .attr("fill-opacity", 0.7)
                .attr("stroke", "var(--edge-stroke)")
                .attr("stroke-width", 0.5),
            update => update,
            exit => exit.remove()
        )
        .attr("d", createArrowPath)


        // zeichnen
        const circles = g.selectAll(".preview-node")
            .data(filteredNodes, d => d.id);

        circles.join(
            enter => enter.append("circle")
                .attr("class", "preview-node")
                .attr("fill", "var(--node-fill)")           // Dynamische Theme-Farbe
                .attr("fill-opacity", 0.5)
                .attr("stroke", "var(--node-stroke)")       // Dynamische Theme-Farbe
                .attr("stroke-width", 1.5)
                .attr("r", d => nodeScale(d.weight || 0)),
            update => update.attr("r", d => nodeScale(d.weight || 0)),
            exit => exit.remove()
        )
        .attr("cx", d => projectPoint(d.lon, d.lat)[0])
        .attr("cy", d => projectPoint(d.lon, d.lat)[1]);
    }

    // Leaflet Zoom/Move-Event binden, damit die D3-SVG sich beim Verschieben der Karte anpasst
    map.on("moveend", updateView);

    // Initialer Render
    updateView();
});