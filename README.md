# N17 Tap

Daily map-tapping game like https://maptap.gg but only for the N17 postcode (Tottenham, London).
Five places a day. Tap the satellite map as close as you can. Rounds 3 to 5 score x2 and x3.

Static site: `index.html` plus `places.json`. Serve any way you like:

    python3 -m http.server 8765

Places come from OpenStreetMap (Overpass, bbox around Tottenham), filtered to outcode N17 via postcodes.io reverse geocoding.
Blurbs come from Wikipedia where OSM has a `wikipedia` tag. Map tiles are Esri World Imagery.

UI is a hand-written homage to maptap (cyan-on-black HUD, coloured round header, monospace reveal label, bottom sheet on mobile).
No maptap code, CSS, or audio is used. Sounds are synthesized in WebAudio: ping on tap, pong on reveal, chord for 90+, clap for a 700+ finish.
N17 boundary polygon: `n17.geojson`, from https://github.com/missinglink/uk-postcode-polygons (Wikipedia postcode district KML, CC BY-SA).
