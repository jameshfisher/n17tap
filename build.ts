import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const OSM_FILE = "osm/area.osm.gz";
const BOUNDARY_FILE = "n17.geojson";
const WIKIDATA_FILE = "wikidata/entities.json.gz";
const SUMMARY_CACHE = "wikipedia/summaries.json";
const OUT_FILE = "places.json";

type LatLng = { lat: number; lng: number };
type Ring = [number, number][];
type Tags = Record<string, string>;

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

type Candidate = {
  id: string;
  name: string;
  kind: string;
  tags: Tags;
  centre: LatLng;
  polygon?: Ring[];
  area: number;
  wikidata?: string;
  wikipedia?: string;
};

const KINDS: Record<string, Record<string, string>> = {
  amenity: {
    pub: "pub",
    bar: "bar",
    library: "library",
    school: "school",
    college: "college",
    university: "university",
    community_centre: "community centre",
    police: "police station",
    fire_station: "fire station",
    theatre: "theatre",
    cinema: "cinema",
    marketplace: "market",
    hospital: "hospital",
    townhall: "town hall",
  },
  leisure: {
    park: "park",
    garden: "garden",
    playground: "playground",
    pitch: "pitch",
    sports_centre: "sports centre",
    stadium: "stadium",
    swimming_pool: "swimming pool",
    nature_reserve: "nature reserve",
    golf_course: "golf course",
    ice_rink: "ice rink",
  },
  shop: {
    supermarket: "supermarket",
    department_store: "department store",
    mall: "shopping centre",
  },
  tourism: {
    museum: "museum",
    hotel: "hotel",
    attraction: "attraction",
    gallery: "gallery",
    zoo: "zoo",
  },
  historic: { castle: "castle", manor: "manor house", monument: "monument" },
  landuse: {
    cemetery: "cemetery",
    recreation_ground: "recreation ground",
    allotments: "allotments",
  },
  railway: { station: "station" },
};

const WORSHIP: Record<string, string> = {
  christian: "church",
  muslim: "mosque",
  jewish: "synagogue",
  hindu: "temple",
  sikh: "gurdwara",
  buddhist: "temple",
};

function kindOf(tags: Tags): string | undefined {
  if (tags.amenity === "place_of_worship")
    return WORSHIP[tags.religion ?? ""] ?? "place of worship";
  if (tags.leisure === "pitch" && tags.sport === "skateboard")
    return "skatepark";
  for (const [key, values] of Object.entries(KINDS)) {
    const v = tags[key];
    if (v && values[v]) return values[v];
  }
  return undefined;
}

function isDefunct(tags: Tags): boolean {
  return Object.keys(tags).some((k) =>
    /^(disused|abandoned|was|demolished|razed|removed):/.test(k)
  );
}

const xml = gunzipSync(readFileSync(OSM_FILE)).toString("utf8");

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
const ways = new Map<string, { nodes: string[]; tags: Tags }>();
for (const m of xml.matchAll(/<way id="(\d+)">([\s\S]*?)<\/way>/g)) {
  ways.set(m[1], {
    nodes: [...m[2].matchAll(/<nd ref="(\d+)"\/>/g)].map((n) => n[1]),
    tags: parseTags(m[2]),
  });
}
const relations = new Map<string, { outers: string[]; tags: Tags }>();
for (const m of xml.matchAll(/<relation id="(\d+)">([\s\S]*?)<\/relation>/g)) {
  const outers = [
    ...m[2].matchAll(/<member type="way" ref="(\d+)" role="(?:outer|)"\/>/g),
  ].map((n) => n[1]);
  relations.set(m[1], { outers, tags: parseTags(m[2]) });
}
console.error(
  `parsed ${nodes.size} nodes, ${ways.size} ways, ${relations.size} relations`
);

function wayRing(id: string): Ring | undefined {
  const way = ways.get(id);
  if (!way) return undefined;
  const ring: Ring = [];
  for (const n of way.nodes) {
    const p = nodes.get(n);
    if (!p) return undefined;
    ring.push([p.lat, p.lng]);
  }
  return ring;
}
function same(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
function closed(ring: Ring): boolean {
  return ring.length > 3 && same(ring[0], ring[ring.length - 1]);
}

function stitchRings(wayIds: string[]): Ring[] | undefined {
  const pending: Ring[] = [];
  for (const id of wayIds) {
    const r = wayRing(id);
    if (!r) return undefined;
    pending.push(r);
  }
  const rings: Ring[] = [];
  while (pending.length) {
    const first = pending.shift();
    if (!first) break;
    const ring = [...first];
    while (!same(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const i = pending.findIndex(
        (w) => same(w[0], end) || same(w[w.length - 1], end)
      );
      if (i < 0) return undefined;
      const [next] = pending.splice(i, 1);
      ring.push(...(same(next[0], end) ? next : [...next].reverse()).slice(1));
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings.length ? rings : undefined;
}

function shoelace(rings: Ring[]): { area: number; centre: LatLng } {
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
  return {
    area: Math.abs(area / 2),
    centre: { lat: cy / (3 * area), lng: cx / (3 * area) },
  };
}

function inRing(pt: LatLng, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i],
      [yj, xj] = ring[j];
    if (
      yi > pt.lat !== yj > pt.lat &&
      pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}
function inPolygon(pt: LatLng, rings: Ring[]): boolean {
  return rings.some((r) => inRing(pt, r));
}

function metres(a: LatLng, b: LatLng): number {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lng - b.lng) * k, a.lat - b.lat) * 111320;
}

const boundary: Ring[] = JSON.parse(
  readFileSync(BOUNDARY_FILE, "utf8")
).geometry.coordinates.map((ring: [number, number][]) =>
  ring.map(([lng, lat]) => [lat, lng])
);

type Entity = {
  label?: string;
  description?: string;
  enwiki?: string;
  claims: Record<string, unknown[]>;
};
const wikidata: Record<string, Entity> = existsSync(WIKIDATA_FILE)
  ? JSON.parse(gunzipSync(readFileSync(WIKIDATA_FILE)).toString("utf8"))
  : {};

function candidate(
  id: string,
  tags: Tags,
  geometry: { centre: LatLng; polygon?: Ring[]; area: number }
): Candidate | undefined {
  const kind = kindOf(tags);
  if (!kind || !tags.name || isDefunct(tags)) return undefined;
  if (!inPolygon(geometry.centre, boundary)) return undefined;
  const wd = tags.wikidata;
  const entity = wd ? wikidata[wd] : undefined;
  if (entity && (entity.claims.P3999 || entity.claims.P576)) return undefined;
  const wikipedia = tags.wikipedia?.startsWith("en:")
    ? tags.wikipedia.slice(3)
    : entity?.enwiki;
  return {
    id,
    name: tags.name,
    kind,
    tags,
    ...geometry,
    wikidata: wd,
    wikipedia,
  };
}

const candidates: Candidate[] = [];
for (const [id, tags] of nodeTags) {
  const centre = nodes.get(id);
  if (!centre) continue;
  const c = candidate(`node/${id}`, tags, { centre, area: 0 });
  if (c) candidates.push(c);
}
for (const [id, way] of ways) {
  if (!kindOf(way.tags)) continue;
  const ring = wayRing(id);
  if (!ring || !closed(ring)) continue;
  const c = candidate(`way/${id}`, way.tags, {
    polygon: [ring],
    ...shoelace([ring]),
  });
  if (c) candidates.push(c);
}
for (const [id, rel] of relations) {
  if (!kindOf(rel.tags)) continue;
  const rings = stitchRings(rel.outers);
  if (!rings) continue;
  const c = candidate(`relation/${id}`, rel.tags, {
    polygon: rings,
    ...shoelace(rings),
  });
  if (c) candidates.push(c);
}
console.error(`${candidates.length} named candidates inside boundary`);

const dropped: string[] = [];
function drop(c: Candidate, why: string) {
  dropped.push(`${c.kind.padEnd(18)} ${c.name.padEnd(50)} ${why}`);
}

const byArea = [...candidates].sort((a, b) => b.area - a.area);
const kept: Candidate[] = [];
for (const c of byArea) {
  const container = kept.find(
    (k) => k.polygon && k.area > c.area && inPolygon(c.centre, k.polygon)
  );
  if (container && !c.wikipedia) {
    drop(c, `inside ${container.name}`);
    continue;
  }
  const twin = kept.find(
    (k) =>
      k.name.toLowerCase() === c.name.toLowerCase() &&
      metres(k.centre, c.centre) < 300
  );
  if (twin) {
    drop(c, `duplicate of ${twin.id}`);
    continue;
  }
  kept.push(c);
}

const summaries: Record<string, { extract: string; url: string } | null> =
  existsSync(SUMMARY_CACHE)
    ? JSON.parse(readFileSync(SUMMARY_CACHE, "utf8"))
    : {};
for (const c of kept) {
  if (!c.wikipedia || c.wikipedia in summaries) continue;
  const res = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(c.wikipedia.replace(/ /g, "_"))}`,
    {
      headers: {
        "User-Agent": "n17tap (https://github.com/jameshfisher/n17tap)",
      },
    }
  );
  if (res.ok) {
    const j = await res.json();
    summaries[c.wikipedia] = {
      extract: j.extract,
      url: j.content_urls.desktop.page,
    };
  } else {
    console.error(`wikipedia ${res.status} for ${c.wikipedia}`);
    summaries[c.wikipedia] = null;
  }
}
writeFileSync(SUMMARY_CACHE, JSON.stringify(summaries, null, 1) + "\n");

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const places: Place[] = kept
  .map((c) => {
    const place: Place = {
      name: c.name,
      kind: c.kind,
      lat: round6(c.centre.lat),
      lng: round6(c.centre.lng),
    };
    if (c.tags["addr:street"]) place.street = c.tags["addr:street"];
    const summary = c.wikipedia ? summaries[c.wikipedia] : undefined;
    if (summary) {
      place.blurb = summary.extract;
      place.url = summary.url;
    }
    if (c.polygon)
      place.polygon = c.polygon.map((r) =>
        r.map(([lat, lng]) => [round6(lat), round6(lng)])
      );
    return place;
  })
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(OUT_FILE, JSON.stringify(places) + "\n");

const counts: Record<string, number> = {};
for (const p of places) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
console.error(`\ndropped:\n${dropped.join("\n")}`);
console.error(
  `\nkept ${places.length} places, ${places.filter((p) => p.polygon).length} with polygons, ${places.filter((p) => p.url).length} with wikipedia`
);
console.error(
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}`)
    .join(", ")
);
