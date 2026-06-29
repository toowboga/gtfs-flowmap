import pandas as pd
import json
import os
import re
import numpy as np
from scipy.spatial import Voronoi
from shapely.geometry import Polygon, box
from sklearn.cluster import AgglomerativeClustering

def clean_station_name(name):
    """
    Bereinigt den Haltestellennamen, um einen semantischen Makro-Knoten (Stadt) zu erzeugen.
    """
    # Häufige Suffixe/Präfixe international und national im Bahnverkehr
    suffixes_to_remove = [
        r'\s*Hbf\b', r'\s*Hauptbahnhof\b', r'\s*\(tief\)', r'\s*\(Stadt\)', 
        r'\s*Ostbahnhof\b', r'\s*Südkreuz\b', r'\s*Gesundbrunnen\b', r'\s*Spandau\b',
        r'\s*Dammtor\b', r'\s*Altona\b', r'\s*Harburg\b', r'\s*Pasing\b', 
        r'\s*Ost\b', r'\s*Süd\b', r'\s*West\b', r'\s*Nord\b',
        r'\s*Messe\b', r'\s*Flughafen\b', r'\s*Airport\b', r'\s*Fernbf\b',
        r'\s*Centraal\b', r'\s*Centrale\b', r'\s*Gare\b', r'hl\.n\.',
        r'\s*Station\b', r'\s*Terminal\b', r'\s*SBB\b', r'\s*HB\b', r'\s*Midi\b',
        r'\s*Paradies\b', r'\s*Göschwitz\b'
    ]
    
    # Typische ÖPNV-Präfixe entfernen (z.B. "S+U Berlin" -> "Berlin")
    cleaned = re.sub(r'^(?:S\+U\s+|S\s+|U\s+)', '', name)
    
    for suffix in suffixes_to_remove:
        cleaned = re.sub(suffix, '', cleaned, flags=re.IGNORECASE)
    
    # Entferne Inhalte in Klammern und alles ab einem Komma
    cleaned = re.sub(r'\(.*?\)', '', cleaned)
    cleaned = cleaned.split(',')[0].strip()
    
    if '-' in cleaned:
        parts = cleaned.split('-')
        if parts[0] in ["Berlin", "München", "Hamburg", "Köln", "Frankfurt", "Stuttgart", "Bruxelles", "Paris", "Milano", "Wien", "Zürich", "Basel", "Praha", "Jena", "Kassel", "Bremen"]:
            cleaned = parts[0]
            
    return cleaned.strip()

def get_time_window(time_str):
    if pd.isna(time_str):
        return 'Unknown'
    try:
        h = int(time_str.split(':')[0]) % 24
        if 0 <= h < 6: return 'Night'
        elif 6 <= h < 12: return 'Morning'
        elif 12 <= h < 18: return 'Afternoon'
        else: return 'Evening'
    except:
        return 'Unknown'

from sklearn.metrics.pairwise import haversine_distances

def cluster_stations(stops, radius_km, stop_weights):
    stops_c = stops.copy()
    stops_c = stops_c.assign(weight=stops_c['stop_id'].map(stop_weights).fillna(0))
    
    if radius_km == 0:
        stops_c = stops_c.assign(
            cluster_id='R0_' + stops_c['stop_id'].astype(str),
            cluster_name=stops_c['stop_name']
        )
        
        cluster_coords = stops_c[['cluster_id', 'cluster_name', 'stop_lat', 'stop_lon', 'weight']].copy()
        return stops_c[['stop_id', 'cluster_id']], cluster_coords

    coords = np.radians(stops_c[['stop_lat', 'stop_lon']].values)
    dist_matrix = haversine_distances(coords, coords)
    distance_threshold = radius_km / 6371.0
    
    clustering = AgglomerativeClustering(
        n_clusters=None, 
        distance_threshold=distance_threshold, 
        metric='precomputed', 
        linkage='complete'
    )
    labels = clustering.fit_predict(dist_matrix)
    stops_c = stops_c.assign(label=labels)
    stops_c = stops_c.assign(cluster_id=f"R{radius_km}_C" + stops_c['label'].astype(str))
    
    # Aggregationsfunktion für den gewichteten Mittelwert
    def weighted_mean_lat(group):
        if group['weight'].sum() == 0: return group['stop_lat'].mean()
        return np.average(group['stop_lat'], weights=group['weight'])

    def weighted_mean_lon(group):
        if group['weight'].sum() == 0: return group['stop_lon'].mean()
        return np.average(group['stop_lon'], weights=group['weight'])

    # Centroids berechnen (Schwerkraft-Modell)
    cluster_coords = stops_c.groupby('cluster_id').apply(
        lambda g: pd.Series({
            'stop_lat': weighted_mean_lat(g),
            'stop_lon': weighted_mean_lon(g),
            'weight': g['weight'].sum()
        }),
        include_groups=False
    ).reset_index()

    # Berechne die Länge des sauberen Namens, um ungültige Namen wie "Hauptbahnhof" zu ignorieren
    stops_c = stops_c.assign(clean_len=stops_c['stop_name'].apply(lambda x: len(clean_station_name(x))))
    stops_c = stops_c.assign(is_valid=stops_c['clean_len'] > 0)
    
    # Sortiere so, dass gültige Namen und hohes Gewicht bevorzugt werden
    stops_sorted = stops_c.sort_values(['is_valid', 'weight'], ascending=[False, False])
    cluster_names = stops_sorted.groupby('cluster_id').first().reset_index()
    
    # Anzahl der eindeutigen Haltestellen pro Cluster ermitteln
    cluster_sizes = stops_c.groupby('cluster_id')['stop_name'].nunique().reset_index(name='station_count')
    cluster_names = cluster_names.merge(cluster_sizes, on='cluster_id')
    
    if radius_km == 0:
        cluster_names = cluster_names.assign(cluster_name=cluster_names['stop_name'])
    else:
        # Intelligente Namensgebung basierend auf Cluster-Größe:
        # Wenn ein Cluster mehrere Bahnhöfe zusammenfasst, wird der bereinigte Namen (z.B. "Berlin") genutzt,
        # um nicht irreführend den Namen eines einzelnen Bahnhofs ("Berlin Hbf") für das ganze Cluster zu verwenden.
        # Besteht ein Cluster nur aus einem Bahnhof, bleibt der exakte Name ("Berlin Spandau") erhalten.
        clean_names = cluster_names['stop_name'].apply(clean_station_name)
        cluster_names = cluster_names.assign(clean_name=clean_names)
        
        def decide_name(row):
            if row['station_count'] > 1:
                return row['clean_name']
            else:
                return row['stop_name']
                
        cluster_names = cluster_names.assign(cluster_name=cluster_names.apply(decide_name, axis=1))
        cluster_names = cluster_names.drop(columns=['clean_name', 'station_count'])
    
    cluster_coords = cluster_coords.merge(cluster_names[['cluster_id', 'cluster_name']], on='cluster_id')
    
    return stops_c[['stop_id', 'cluster_id']], cluster_coords

def generate_voronoi_geojson(cluster_coords, radius):
    if len(cluster_coords) < 4:
        return {"type": "FeatureCollection", "features": []}
        
    coords = cluster_coords[['stop_lon', 'stop_lat']].values
    
    # Bounding Box über Europa
    bbox = box(-10, 35, 30, 65) 
    
    # Dummy-Punkte weit außen
    dummy_points = np.array([
        [-100, -100], [100, -100], [100, 100], [-100, 100]
    ])
    vor_coords = np.vstack([coords, dummy_points])
    
    vor = Voronoi(vor_coords)
    
    features = []
    for i in range(len(coords)):
        region_idx = vor.point_region[i]
        region = vor.regions[region_idx]
        
        if -1 not in region and len(region) > 0:
            polygon_coords = [vor.vertices[v] for v in region]
            poly = Polygon(polygon_coords)
            
            if not poly.is_valid:
                poly = poly.buffer(0)
                
            clipped_poly = poly.intersection(bbox)
            
            if not clipped_poly.is_empty:
                geo_coords = []
                if clipped_poly.geom_type == 'Polygon':
                    geo_coords = [list(clipped_poly.exterior.coords)]
                elif clipped_poly.geom_type == 'MultiPolygon':
                    largest = max(clipped_poly.geoms, key=lambda a: a.area)
                    geo_coords = [list(largest.exterior.coords)]
                else:
                    continue
                    
                features.append({
                    "type": "Feature",
                    "properties": {
                        "cluster_id": cluster_coords.iloc[i]['cluster_id'],
                        "cluster_name": cluster_coords.iloc[i]['cluster_name'],
                        "radius": radius
                    },
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": geo_coords
                    }
                })
                
    return {
        "type": "FeatureCollection",
        "features": features
    }

def main():
    data_dir = '../data/gtfs-data'
    output_dir = '../data/processed'

    print("Lese GTFS-Daten ein...")
    # 1. Stops und Agencies laden
    stops_df = pd.read_csv(os.path.join(data_dir, 'stops.txt'), dtype={'stop_id': str, 'parent_station': str})
    
    # Mapping von stop_id auf stop_name, um Child-Plattformen nach ihrem Parent zu benennen
    id_to_name = stops_df.set_index('stop_id')['stop_name'].to_dict()
    
    def get_real_name(row):
        if pd.notna(row['parent_station']) and row['parent_station'] in id_to_name:
            return id_to_name[row['parent_station']]
        return row['stop_name']
        
    stops_df['stop_name'] = stops_df.apply(get_real_name, axis=1)
    
    # Nur benötigte Spalten
    stops = stops_df[['stop_id', 'stop_name', 'stop_lat', 'stop_lon']]
    
    try:
        agency_df = pd.read_csv(os.path.join(data_dir, 'agency.txt'), dtype={'agency_id': str})
        if 'agency_id' in agency_df.columns:
            agency_export = dict(zip(agency_df['agency_id'], agency_df['agency_name']))
        else:
            # Falls agency_id fehlt (optional, wenn nur eine Agency vorhanden ist)
            agency_export = {"1": agency_df['agency_name'].iloc[0]}
    except FileNotFoundError:
        agency_export = {}
    
    # 2. Kalender laden, um Frequenz pro Woche zu berechnen
    calendar = pd.read_csv(os.path.join(data_dir, 'calendar.txt'))
    # Berechne wie viele Tage pro Woche ein service_id fährt
    days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    calendar = calendar.assign(days_per_week=calendar[days].sum(axis=1))
    service_freq = calendar[['service_id', 'days_per_week']].copy()
    
    # 3. Trips und Routes laden
    trips = pd.read_csv(os.path.join(data_dir, 'trips.txt'), dtype={'trip_id': str, 'route_id': str})
    routes = pd.read_csv(os.path.join(data_dir, 'routes.txt'), dtype={'route_id': str})

    # Verbinde Trips mit Routen-Infos (Zugtyp) und Frequenz
    trips_merged = trips.merge(routes[['route_id', 'route_short_name', 'agency_id']], on='route_id', how='left')
    trips_merged = trips_merged.merge(service_freq, on='service_id', how='left')
    # Falls service_id nicht im calendar (sondern nur in calendar_dates) ist, nehmen wir als Fallback 1 Tag / Woche an (Sonderfahrten)
    trips_merged = trips_merged.assign(days_per_week=trips_merged['days_per_week'].fillna(1))
    
    # 4. Stop Times laden
    print("Lese stop_times.txt ein...")
    stop_times = pd.read_csv(os.path.join(data_dir, 'stop_times.txt'), 
                             dtype={'trip_id': str, 'stop_id': str}, 
                             usecols=['trip_id', 'stop_id', 'stop_sequence', 'departure_time'])
    
    # 5. Kantenbildung Basis
    print("Erzeuge Basis-Kanten...")
    st_merged = stop_times.merge(trips_merged[['trip_id', 'route_short_name', 'agency_id', 'days_per_week']], on='trip_id', how='inner')
    st_merged = st_merged.assign(time_window=st_merged['departure_time'].apply(get_time_window))
    st_merged = st_merged.sort_values(['trip_id', 'stop_sequence']).copy()
    
    st_merged = st_merged.assign(
        next_trip_id=st_merged['trip_id'].shift(-1),
        dest_stop_id=st_merged['stop_id'].shift(-1)
    )
    
    edges_raw = st_merged[st_merged['trip_id'] == st_merged['next_trip_id']].copy()
    edges_raw = edges_raw.assign(daily_trips=edges_raw['days_per_week'] / 7.0)
    
    # Gewichte für Bahnhöfe berechnen (um den größten Bahnhof im Cluster zu finden)
    weights_df = edges_raw.groupby('stop_id')['daily_trips'].sum().reset_index()
    stop_weights = dict(zip(weights_df['stop_id'], weights_df['daily_trips']))
    
    radii = [0, 5, 10, 25, 50]
    nodes_export = []
    edges_export = []
    regions_export = {"type": "FeatureCollection", "features": []}
    
    for radius in radii:
        print(f"Berechne Hierarchie-Ebene für Radius {radius} km...")
        
        cluster_map, cluster_coords = cluster_stations(stops, radius, stop_weights)
        
        for _, row in cluster_coords.iterrows():
            nodes_export.append({
                'id': row['cluster_id'],
                'name': row['cluster_name'],
                'lat': row['stop_lat'],
                'lon': row['stop_lon'],
                'radius': radius,
                'weight': float(row['weight'])
            })
            
        if radius > 0:
            geojson = generate_voronoi_geojson(cluster_coords, radius)
            regions_export['features'].extend(geojson['features'])
            
        # Kanten aggregieren
        edges_radius = edges_raw.copy()
        cmap = dict(zip(cluster_map['stop_id'], cluster_map['cluster_id']))
        cname_map = dict(zip(cluster_coords['cluster_id'], cluster_coords['cluster_name']))
        
        edges_radius = edges_radius.assign(
            origin_cluster=edges_radius['stop_id'].map(cmap),
            dest_cluster=edges_radius['dest_stop_id'].map(cmap)
        )
        
        # Intra-Cluster Flows entfernen
        edges_radius = edges_radius[edges_radius['origin_cluster'] != edges_radius['dest_cluster']]
        
        edges_agg = edges_radius.groupby(
            ['origin_cluster', 'dest_cluster', 'route_short_name', 'agency_id', 'time_window']
        )['daily_trips'].sum().reset_index()
        
        for _, row in edges_agg.iterrows():
            edges_export.append({
                'origin_id': row['origin_cluster'],
                'origin_name': cname_map.get(row['origin_cluster'], ""),
                'dest_id': row['dest_cluster'],
                'dest_name': cname_map.get(row['dest_cluster'], ""),
                'train_type': row['route_short_name'],
                'agency_id': row['agency_id'],
                'time_window': row['time_window'],
                'daily_trips': round(row['daily_trips'], 2),
                'radius': radius
            })
            
    print(f"Exportiere Daten nach {output_dir}...")
    os.makedirs(output_dir, exist_ok=True)
    
    with open(os.path.join(output_dir, 'nodes.json'), 'w', encoding='utf-8') as f:
        json.dump(nodes_export, f, ensure_ascii=False, indent=2)
        
    with open(os.path.join(output_dir, 'edges.json'), 'w', encoding='utf-8') as f:
        json.dump(edges_export, f, ensure_ascii=False, indent=2)
        
    with open(os.path.join(output_dir, 'regions.geojson'), 'w', encoding='utf-8') as f:
        json.dump(regions_export, f, ensure_ascii=False, indent=2)
        
    with open(os.path.join(output_dir, 'agencies.json'), 'w', encoding='utf-8') as f:
        json.dump(agency_export, f, ensure_ascii=False, indent=2)
        
    print("Fertig!")

if __name__ == '__main__':
    main()
