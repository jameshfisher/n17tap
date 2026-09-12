# N17 Tap

Daily map-tapping game like https://maptap.gg but only for the N17 postcode (Tottenham, London).
Five places a day. Tap the satellite map as close as you can. Rounds 3 to 5 score x2 and x3.

Static site: `index.html` plus `places.json`. Serve any way you like:

    python3 -m http.server 8765

## Data

`places.json` is generated. Do not edit it by hand.

    bun build.ts

- `osm/area.osm.gz`: raw OpenStreetMap XML for N17 and neighbouring districts, fetched by `osm/fetch.sh`. Snapshot 12 Sep 2026.
- `places.src.json`: the curated list. One entry per place: OSM id, kind, optional blurb and url. Blurbs are Wikipedia summaries.
- `build.ts`: resolves each OSM id in the snapshot to a name, street, centroid and, for ways and multipolygon relations, an outline polygon.

Places with a polygon score 100 anywhere inside it. Outside, distance is measured to the nearest edge.
Map tiles are Esri World Imagery.

UI is a hand-written homage to maptap (cyan-on-black HUD, coloured round header, monospace reveal label, bottom sheet on mobile).
No maptap code, CSS, or audio is used. Sounds are synthesized in WebAudio: ping on tap, pong on reveal, chord for 90+, clap for a 700+ finish.
N17 boundary polygon: `n17.geojson`, from https://github.com/missinglink/uk-postcode-polygons (Wikipedia postcode district KML, CC BY-SA).
