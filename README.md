# N17 Tap

Daily map-tapping game like https://maptap.gg but only for the N17 postcode (Tottenham, London).
Five places a day. Tap the satellite map as close as you can. Rounds 3 to 5 score x2 and x3.

Static site: `index.html` plus `places.json`. Serve any way you like:

    python3 -m http.server 8765

## Data

`places.json` is generated. Do not edit it by hand.

    bun build.ts

Inputs:

- `osm/area.osm.gz`: raw OpenStreetMap XML for N17 and neighbouring districts, fetched by `osm/fetch.sh`. Snapshot 12 Sep 2026.
- `n17.geojson`: the district boundary. Only objects whose centroid is inside count.
- `wikidata/entities.json.gz`: every Wikidata entity referenced by a `wikidata` tag in the snapshot, fetched by `wikidata/fetch.ts`. Used for the Wikipedia article title and to skip closed places.
- `wikipedia/summaries.json`: cached Wikipedia summaries. The build fetches any it is missing.

Rules, in order:

1. Named OSM object with a tag in the `KINDS` table in `build.ts`: pubs, parks, schools, churches, stations, supermarkets and so on.
2. Centroid inside the boundary.
3. Not tagged `disused:*` or similar, and not marked closed in Wikidata.
4. If it sits inside a bigger kept place and has no Wikipedia article, the bigger place wins. So "Toddler Play Area" inside a park is dropped but Bruce Castle inside its park stays.
5. Same name within 300 m is a duplicate. The larger one wins.

No hand curation. To run this for another district: replace the boundary file, refetch the OSM box, refetch Wikidata, rebuild.

Places with a polygon score 100 anywhere inside it. Outside, distance is measured to the nearest edge.
Map tiles are Esri World Imagery.

UI is a hand-written homage to maptap (cyan-on-black HUD, coloured round header, monospace reveal label, bottom sheet on mobile).
No maptap code, CSS, or audio is used. Sounds are synthesized in WebAudio: ping on tap, pong on reveal, chord for 90+, clap for a 700+ finish.
N17 boundary polygon: `n17.geojson`, from https://github.com/missinglink/uk-postcode-polygons (Wikipedia postcode district KML, CC BY-SA).
