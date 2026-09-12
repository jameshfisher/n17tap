#!/bin/sh
# Raw OSM XML for N17 and neighbouring districts (N9 N15 N18 N22 E17 E10).
# osm.org's /map call caps at 50k nodes, so this uses Overpass, which returns the same format.
set -e
cd "$(dirname "$0")"
curl -s --data-urlencode 'data=[out:xml][timeout:300][maxsize:1073741824];(nwr(51.56,-0.13,51.63,0.0);>;);out;' \
  https://overpass-api.de/api/interpreter | gzip > area.osm.gz
ls -la area.osm.gz
