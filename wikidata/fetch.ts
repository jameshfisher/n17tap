import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

const xml = gunzipSync(readFileSync("osm/area.osm.gz")).toString("utf8");
const ids = [...new Set([...xml.matchAll(/k="wikidata" v="(Q\d+)"/g)].map((m) => m[1]))].sort(
  (a, b) => Number(a.slice(1)) - Number(b.slice(1))
);
console.error(`${ids.length} distinct Q ids in osm/area.osm.gz`);

type Entity = {
  id: string;
  label?: string;
  description?: string;
  enwiki?: string;
  claims: Record<string, unknown>;
};

const out: Record<string, Entity> = {};
for (let i = 0; i < ids.length; i += 50) {
  const batch = ids.slice(i, i + 50);
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=${batch.join("|")}&props=labels|descriptions|sitelinks|claims&languages=en&sitefilter=enwiki`;
  const res = await fetch(url, { headers: { "User-Agent": "n17tap (https://github.com/jameshfisher/n17tap)" } });
  if (!res.ok) throw new Error(`${res.status} for batch at ${i}`);
  const json = await res.json();
  for (const [id, e] of Object.entries<any>(json.entities)) {
    if (e.missing !== undefined) { console.error(`missing ${id}`); continue; }
    out[id] = {
      id,
      label: e.labels?.en?.value,
      description: e.descriptions?.en?.value,
      enwiki: e.sitelinks?.enwiki?.title,
      claims: e.claims ?? {},
    };
  }
  console.error(`${Math.min(i + 50, ids.length)}/${ids.length}`);
}
writeFileSync("wikidata/entities.json.gz", gzipSync(JSON.stringify(out)));
console.error(`wrote ${Object.keys(out).length} entities`);
