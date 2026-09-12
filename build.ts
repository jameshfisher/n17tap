import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

type LatLng = { lat: number; lng: number };
type Ring = [number, number][];

type Source = { osm: string; kind?: string; blurb?: string; url?: string };

type Place = {
  name: string;
  kind: string;
  lat: number;
  lng: number;
  street?: string;
  blurb?: string;
  url?: string;
  polygon?: Ring[];
};

type Tags = Record<string, string>;
type Way = { nodes: string[]; tags: Tags };
type Relation = { outers: string[]; tags: Tags };

const xml = gunzipSync(readFileSync("osm/area.osm.gz")).toString("utf8");

function parseTags(body: string): Tags {
  const tags: Tags = {};
  for (const m of body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g))
    tags[unescape(m[1])] = unescape(m[2]);
  return tags;
}
function unescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const nodes = new Map<string, LatLng>();
const nodeTags = new Map<string, Tags>();
for (const m of xml.matchAll(
  /<node id="(\d+)" lat="([^"]+)" lon="([^"]+)"(?:\/>|>([\s\S]*?)<\/node>)/g
)) {
  nodes.set(m[1], { lat: Number(m[2]), lng: Number(m[3]) });
  if (m[4]) nodeTags.set(m[1], parseTags(m[4]));
}
const ways = new Map<string, Way>();
for (const m of xml.matchAll(/<way id="(\d+)">([\s\S]*?)<\/way>/g)) {
  ways.set(m[1], {
    nodes: [...m[2].matchAll(/<nd ref="(\d+)"\/>/g)].map((n) => n[1]),
    tags: parseTags(m[2]),
  });
}
const relations = new Map<string, Relation>();
for (const m of xml.matchAll(/<relation id="(\d+)">([\s\S]*?)<\/relation>/g)) {
  const outers = [
    ...m[2].matchAll(/<member type="way" ref="(\d+)" role="(?:outer|)"\/>/g),
  ].map((n) => n[1]);
  relations.set(m[1], { outers, tags: parseTags(m[2]) });
}
console.error(
  `parsed ${nodes.size} nodes, ${ways.size} ways, ${relations.size} relations`
);

function wayRing(id: string): Ring {
  const way = ways.get(id);
  if (!way) throw new Error(`missing way ${id}`);
  return way.nodes.map((n) => {
    const p = nodes.get(n);
    if (!p) throw new Error(`missing node ${n} of way ${id}`);
    return [p.lat, p.lng];
  });
}

function stitchRings(wayIds: string[]): Ring[] {
  const pending = wayIds.map((id) => ({ id, coords: wayRing(id) }));
  const rings: Ring[] = [];
  while (pending.length) {
    const first = pending.shift();
    if (!first) break;
    const ring = [...first.coords];
    while (!same(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const i = pending.findIndex(
        (w) =>
          same(w.coords[0], end) || same(w.coords[w.coords.length - 1], end)
      );
      if (i < 0) throw new Error(`open ring starting at way ${first.id}`);
      const [next] = pending.splice(i, 1);
      const seg = same(next.coords[0], end)
        ? next.coords
        : [...next.coords].reverse();
      ring.push(...seg.slice(1));
    }
    rings.push(ring);
  }
  return rings;
}
function same(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function centroid(rings: Ring[]): LatLng {
  let area = 0,
    cx = 0,
    cy = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [y1, x1] = ring[i],
        [y2, x2] = ring[i + 1];
      const f = x1 * y2 - x2 * y1;
      area += f;
      cx += (x1 + x2) * f;
      cy += (y1 + y2) * f;
    }
  }
  return { lat: cy / (3 * area), lng: cx / (3 * area) };
}

function kindOf(tags: Tags): string {
  if (tags.amenity === "place_of_worship") {
    if (tags.religion === "muslim") return "mosque";
    if (tags.religion === "christian") return "church";
  }
  if (tags.leisure === "pitch" && tags.sport === "skateboard") return "skatepark";
  if (tags.landuse === "recreation_ground" || tags.leisure === "garden") return "park";
  if (tags.amenity === "police") return "police station";
  if (tags.amenity === "theatre") return "outdoor theatre";
  if (tags.amenity === "marketplace") return "market";
  if (tags.railway === "station") return "station";
  const tag = tags.amenity ?? tags.leisure ?? tags.shop ?? tags.tourism ?? tags.landuse ?? tags.historic;
  if (!tag) throw new Error(`no kind for ${JSON.stringify(tags)}`);
  return tag.replace(/_/g, " ");
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function resolve(src: Source): Place {
  const [type, id] = src.osm.split("/");
  let tags: Tags, centre: LatLng, polygon: Ring[] | undefined;
  if (type === "node") {
    const p = nodes.get(id);
    if (!p) throw new Error(`missing node ${id}`);
    tags = nodeTags.get(id) ?? {};
    centre = p;
  } else if (type === "way") {
    const way = ways.get(id);
    if (!way) throw new Error(`missing way ${id}`);
    tags = way.tags;
    const ring = wayRing(id);
    if (!same(ring[0], ring[ring.length - 1]))
      throw new Error(`way ${id} is not closed`);
    polygon = [ring];
    centre = centroid(polygon);
  } else {
    const rel = relations.get(id);
    if (!rel) throw new Error(`missing relation ${id}`);
    tags = rel.tags;
    polygon = stitchRings(rel.outers);
    centre = centroid(polygon);
  }
  const name = tags.name;
  if (!name) throw new Error(`${src.osm} has no name`);
  const place: Place = {
    name,
    kind: src.kind ?? kindOf(tags),
    lat: round6(centre.lat),
    lng: round6(centre.lng),
  };
  if (tags["addr:street"]) place.street = tags["addr:street"];
  if (src.blurb) place.blurb = src.blurb;
  if (src.url) place.url = src.url;
  if (polygon)
    place.polygon = polygon.map((r) =>
      r.map(([lat, lng]) => [round6(lat), round6(lng)])
    );
  return place;
}

const sources: Source[] = JSON.parse(readFileSync("places.src.json", "utf8"));
const places = sources
  .map(resolve)
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync("places.json", JSON.stringify(places) + "\n");
const withPoly = places.filter((p) => p.polygon).length;
console.error(`wrote ${places.length} places, ${withPoly} with polygons`);
