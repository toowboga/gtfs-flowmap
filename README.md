# Flowmap Visualization für GTFS Daten

## Projektbeschreibung

Dieses Projekt beschäftigt sich mit der Analyse und Visualisierung von Flow Maps des deutschen Bahnverkehrs. Der verwendete Datensatz `Schienenfernverkehr Deutschland` beinhaltet den Schienenfernverkehr (ICE, IC). Ziel ist es, aus fahrplanbasierten GTFS-Daten (General Transit Feed Specification) die Kapazitätsdichte, Taktung und Struktur des Netzes räumlich verständlich darzustellen. Der Datensatz ist austauschbar und kann durch beliebige auf Deutschland bezogene GTFS-Datensätze ersetzt werden. Beispielsweise durch den Datensatz `Schienenregionalverkehr Deutschland`.

## Architektur & Ordnerstruktur (Hybrider Ansatz)

Das Projekt kombiniert Datenverarbeitung mit einer Web-Visualisierung:

* **`python/` (Python):** Übernimmt die Datenverarbeitung. Die GTFS-Daten werden geparst, Haltestellen zu Makro-Knoten (Clustern) zusammengefasst und die Bewegungen als Origin-Destination-Matrix (Start-Ziel-Flüsse) vorberechnet.
* **`vis/` (JavaScript / D3.js & Leaflet):** Übernimmt die interaktive Darstellung. Die vorberechneten Daten werden im Browser gerendert.
* **`data/`:** Enthält die GTFS-Rohdaten (`gtfs-data/`) sowie die vom Python-Backend generierten Export-Dateien (`processed/`).

## Setup & Ausführung

### 1. Datenvorverarbeitung (Python)
Voraussetzung: Python 3.8+ installiert.
```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python generate_od_matrix.py
```
Dies generiert die Dateien `nodes.json`, `edges.json` und `regions.geojson` im Ordner `data/processed/`.

### 2. Visualisierung (UI)

Für die Visualisierung kann ein lokaler Webserver im Hauptverzeichnis des Projekts (oder im Ordner `vis`) gestartet werden:
```bash
python -m http.server 8000
```
Öffne anschließend den Browser unter `http://localhost:8000/vis/` (bzw. `http://localhost:8000/`, falls der Server im `vis` Ordner gestartet wurde).

![Flowmap des deutschen Schienenfernverkehrs](Flowmap.png)

## Visualisierungskonzept

Um Überlappungen und visuelles Rauschen ("Clutter") zu vermeiden, orientiert sich die Darstellung an etablierten Ansätzen der Visual Analytics (vgl. Spatial Generalization and Aggregation
of Massive Movement Data, Andrienko & Andrienko, 2011, DOI: [10.1109/TVCG.2010.44](10.1109/TVCG.2010.44)):

* **Gerichtete Flüsse (Halbpfeil-Konzept):** Bewegungen werden als asymmetrische Halbpfeile dargestellt. So lassen sich Verkehrsströme in entgegengesetzte Richtungen auf derselben Strecke (z. B. A $\rightarrow$ B vs. B $\rightarrow$ A) klar unterscheiden.
* **Gewichtung (Flüsse):** Die Liniendicke der Flüsse repräsentiert die Verkehrsstärke (Anzahl der Fahrten).
* **Knoten-Skalierung (Hubs):** Die Größe der Bahnhofs- bzw. Cluster-Knoten (Nodes) skaliert dynamisch mit ihrer errechneten Relevanz (Gewichtung), um wichtige Verkehrsknotenpunkte sofort erkennbar zu machen.
* **Basiskarte & Theming:** Die Flows werden auf einer dezent gehaltenen Map (Leaflet) platziert, um den geografischen Kontext ohne farbliche Ablenkung zu veranschaulichen. Die App unterstützt zudem ein Umschalten zwischen **Dark Mode**, **Light Mode** und dem **System-Standard**.

Die Karte Deutschlands wird dabei in Einzugsgebiete (Voronoi-Polygone) unterteilt, die sich interaktiv ein- und ausblenden lassen.

## Interaktive Funktionen

Die Visualisierung ist explorativ aufgebaut und soll folgende Interaktionen ermöglichen:

### Semantisches Clustering & Zoom
 
 Die räumliche Auflösung der Flows passt sich dynamisch an die Zoom-Stufe der Karte an, basierend auf in Python vorbereiteten Hierarchien:
 
 * **Makro-Ebene (Rausgezoomt):** Räumliches Agglomeratives Clustering fasst Bahnhöfe nach ihrer Haversine-Distanz (z.B. 25km oder 50km) zusammen. So entstehen saubere Metropolregionen.
 * **Mikro-Ebene (Reingezoomt):** Auflösung der Cluster in Einzelbahnhöfe und Darstellung der feingranularen regionalen Verbindungen (0km).
 
 *Tipp: Die Cluster-Auflösung lässt sich über den Slider im UI ("Cluster-Radius") fließend einstellen.*

### Rauschfilter & Orphan-Node Filterung

Zur besseren Lesbarkeit kann die Darstellung dynamisch angepasst werden:

* Ausblenden seltener Verbindungen (z. B. "Zeige nur Flüsse mit > 5 Fahrten pro Tag").
* **Automatische Waisen-Filterung (Orphan-Nodes):** Bahnhöfe, die durch Filter-Einstellungen isoliert werden (keine aktiven ankommenden oder abgehenden Verbindungen mehr besitzen), werden automatisch ausgeblendet, um die Karte aufgeräumt zu halten.
* Hervorhebung stark frequentierter Strecken.
* Steuerung über interaktive UI-Slider.

### Kategorische & Zeitliche Filter

Die Verkehrsströme können nach verschiedenen Kriterien eingegrenzt werden:

* **Zugtyp:** Trennung von Hochgeschwindigkeitsnetz (ICE) und Ergänzungsnetz (IC/EC).
* **Betreiber (Agency):** Vergleich von Marktanteilen (z. B. Deutsche Bahn, ÖBB, Flixtrain etc.).
* **Zeiträume:** Analyse der Tagesdynamik (z. B. Tageszeit, Wochentag, Woche).

## Datenbasis

* **GTFS-Datensatz:** Schienenfernverkehr Deutschland (Quelle: [gtfs.de](https://gtfs.de/de/feeds/), Basis: NeTEx / DELFI e.V.)
* Die Daten umfassen ca. 6.000 eindeutige Trips und 1.200 Stops über einen Zeitraum von 30 Tagen.
* Zeitraum: 23.05.2026 - 20.06.2026

> *Hinweis:* Der im Repository enthaltene GTFS-Datensatz kann einfach durch einen aktuelleren Datensatz erstezt werden, bspw. durch den *Schienenfernverkehr Deutschland*, *Öffentlicher Nahverkehr Deutschland* oder *Schienenregionalverkehr Deutschland*.

## Technologiestack

* **Python (Daten)**
  * *Pandas:* Datenverarbeitung, GTFS Parsing
  * Vorberechnung von semantischen Clustern & Aggregation der Kanten (Edges)
  * JSON-Export/JS-Export für das UI

* **JavaScript (UI)**
  * *D3.js:* SVG-Rendering (Flows, Halbpfeile, dynamische Liniendicken)
  * *Leaflet.js:* Interaktive Kartenbasis (Slippy Map)
  * HTML/CSS/JS für UI-Steuerelemente (Slider, Dropdowns, Tooltips, ...)