import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const OSM_FILE = "osm/area.osm.gz";
const BOUNDARY_FILE = "n17.geojson";
const WIKIDATA_FILE = "wikidata/entities.json.gz";
const SUMMARY_CACHE = "wikipedia/summaries.json";
const OUT_FILE = "places.json";

const CUTOFF = 5;
const WIKIPEDIA_BONUS = 2;

type LatLng = { lat: number; lng: number };
type Ring = [number, number][];
type Tags = Record<string, string>;

type Place = {
  name: string;
  kind: string;
  difficulty: number;
  lat: number;
  lng: number;
  street?: string;
  blurb?: string;
  url?: string;
  polygon?: Ring[];
  lines?: Ring[];
  commonsFile?: string;
};

type Candidate = {
  id: string;
  name: string;
  kind: string;
  base: number;
  tags: Tags;
  centre: LatLng;
  polygon?: Ring[];
  lines?: Ring[];
  size: number;
  wikidata?: string;
  wikipedia?: string;
  score: number;
};

type Kind = { kind: string; base: number };

const KINDS: Record<string, Record<string, Kind>> = {
  amenity: {
    pub: { kind: "pub", base: 5 },
    bar: { kind: "bar", base: 3 },
    library: { kind: "library", base: 6 },
    school: { kind: "school", base: 5 },
    college: { kind: "college", base: 6 },
    university: { kind: "university", base: 7 },
    community_centre: { kind: "community centre", base: 4 },
    police: { kind: "police station", base: 6 },
    fire_station: { kind: "fire station", base: 5 },
    theatre: { kind: "theatre", base: 6 },
    cinema: { kind: "cinema", base: 6 },
    marketplace: { kind: "market", base: 7 },
    hospital: { kind: "hospital", base: 9 },
    townhall: { kind: "town hall", base: 8 },
  },
  leisure: {
    park: { kind: "park", base: 7 },
    garden: { kind: "garden", base: 3 },
    playground: { kind: "playground", base: 2 },
    pitch: { kind: "pitch", base: 2 },
    sports_centre: { kind: "sports centre", base: 5 },
    stadium: { kind: "stadium", base: 10 },
    swimming_pool: { kind: "swimming pool", base: 5 },
    nature_reserve: { kind: "nature reserve", base: 6 },
    golf_course: { kind: "golf course", base: 6 },
    ice_rink: { kind: "ice rink", base: 6 },
  },
  shop: {
    supermarket: { kind: "supermarket", base: 5 },
    department_store: { kind: "department store", base: 7 },
    mall: { kind: "shopping centre", base: 8 },
  },
  tourism: {
    museum: { kind: "museum", base: 7 },
    hotel: { kind: "hotel", base: 4 },
    attraction: { kind: "attraction", base: 5 },
    gallery: { kind: "gallery", base: 4 },
    zoo: { kind: "zoo", base: 8 },
  },
  historic: {
    castle: { kind: "castle", base: 8 },
    manor: { kind: "manor house", base: 6 },
    monument: { kind: "monument", base: 5 },
  },
  landuse: {
    cemetery: { kind: "cemetery", base: 6 },
    recreation_ground: { kind: "recreation ground", base: 6 },
    allotments: { kind: "allotments", base: 3 },
  },
  railway: { station: { kind: "station", base: 9 } },
};

const WORSHIP: Record<string, string> = {
  christian: "church",
  muslim: "mosque",
  jewish: "synagogue",
  hindu: "temple",
  sikh: "gurdwara",
  buddhist: "temple",
};

const ROADS: Record<string, number> = {
  trunk: 7,
  primary: 7,
  secondary: 6,
  tertiary: 5,
  pedestrian: 2,
  unclassified: 3.5,
  residential: 3.5,
  living_street: 2,
};

function kindOf(tags: Tags): Kind | undefined {
  if (tags.amenity === "place_of_worship")
    return { kind: WORSHIP[tags.religion ?? ""] ?? "place of worship", base: 4 };
  if (tags.leisure === "pitch" && tags.sport === "skateboard")
    return { kind: "skatepark", base: 4 };
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

const METRES_PER_DEGREE = 111320;

function metres(a: LatLng, b: LatLng): number {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lng - b.lng) * k, a.lat - b.lat) * METRES_PER_DEGREE;
}

function shoelace(rings: Ring[]): { squareMetres: number; centre: LatLng } {
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
  const centre = { lat: cy / (3 * area), lng: cx / (3 * area) };
  const k = Math.cos((centre.lat * Math.PI) / 180);
  return {
    squareMetres: Math.abs(area / 2) * METRES_PER_DEGREE * METRES_PER_DEGREE * k,
    centre,
  };
}

function lineLength(line: Ring): number {
  let total = 0;
  for (let i = 0; i < line.length - 1; i++)
    total += metres(
      { lat: line[i][0], lng: line[i][1] },
      { lat: line[i + 1][0], lng: line[i + 1][1] }
    );
  return total;
}

function midpoint(line: Ring): LatLng {
  const half = lineLength(line) / 2;
  let walked = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = { lat: line[i][0], lng: line[i][1] };
    const b = { lat: line[i + 1][0], lng: line[i + 1][1] };
    const d = metres(a, b);
    if (walked + d >= half) {
      const t = d ? (half - walked) / d : 0;
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    walked += d;
  }
  return { lat: line[0][0], lng: line[0][1] };
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

function wikipediaTitle(tags: Tags): string | undefined {
  if (tags.wikipedia?.startsWith("en:")) return tags.wikipedia.slice(3);
  return tags.wikidata ? wikidata[tags.wikidata]?.enwiki : undefined;
}

function stringAt(v: unknown, ...path: string[]): string | undefined {
  let cur: unknown = v;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null || !(key in cur)) return undefined;
    cur = Reflect.get(cur, key);
  }
  return typeof cur === "string" ? cur : undefined;
}

function wikidataImage(tags: Tags): string | undefined {
  const entity = tags.wikidata ? wikidata[tags.wikidata] : undefined;
  return stringAt(entity?.claims.P18?.[0], "mainsnak", "datavalue", "value");
}

function commonsFileFromThumb(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const m = url.match(/\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]).replace(/_/g, " ") : undefined;
}

function isClosed(tags: Tags): boolean {
  const entity = tags.wikidata ? wikidata[tags.wikidata] : undefined;
  return Boolean(entity && (entity.claims.P3999 || entity.claims.P576));
}

function insideFraction(rings: Ring[]): number {
  const pts = rings.flat();
  const lats = pts.map((q) => q[0]);
  const lngs = pts.map((q) => q[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const steps = 40;
  let inShape = 0, inBoth = 0;
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++) {
      const pt = {
        lat: minLat + ((maxLat - minLat) * (i + 0.5)) / steps,
        lng: minLng + ((maxLng - minLng) * (j + 0.5)) / steps,
      };
      if (!inPolygon(pt, rings)) continue;
      inShape++;
      if (inPolygon(pt, boundary)) inBoth++;
    }
  return inShape ? inBoth / inShape : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function candidate(
  id: string,
  tags: Tags,
  geometry: { centre: LatLng; polygon?: Ring[]; squareMetres: number }
): Candidate | undefined {
  const kind = kindOf(tags);
  if (!kind || !tags.name || isDefunct(tags) || isClosed(tags)) return undefined;
  const inside = geometry.polygon
    ? insideFraction(geometry.polygon)
    : inPolygon(geometry.centre, boundary) ? 1 : 0;
  if (inside === 0) return undefined;
  const squareMetres = geometry.squareMetres * inside;
  const wikipedia = wikipediaTitle(tags);
  const sizeBonus = clamp(Math.log10(squareMetres) - 3, 0, 3);
  return {
    id,
    name: tags.name,
    ...kind,
    tags,
    centre: geometry.centre,
    polygon: geometry.polygon,
    size: squareMetres,
    wikidata: tags.wikidata,
    wikipedia,
    score: kind.base + sizeBonus + (wikipedia ? WIKIPEDIA_BONUS : 0),
  };
}

const candidates: Candidate[] = [];
for (const [id, tags] of nodeTags) {
  const centre = nodes.get(id);
  if (!centre) continue;
  const c = candidate(`node/${id}`, tags, { centre, squareMetres: 0 });
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

const roads = new Map<string, { lines: Ring[]; tags: Tags; base: number }>();
for (const [id, way] of ways) {
  const base = ROADS[way.tags.highway ?? ""];
  if (base === undefined || !way.tags.name) continue;
  const line = wayRing(id);
  if (!line || line.length < 2) continue;
  if (!inPolygon(midpoint(line), boundary)) continue;
  const road = roads.get(way.tags.name) ?? { lines: [], tags: way.tags, base };
  road.lines.push(line);
  road.base = Math.max(road.base, base);
  if (wikipediaTitle(way.tags)) road.tags = way.tags;
  roads.set(way.tags.name, road);
}
for (const [name, road] of roads) {
  const length = road.lines.reduce((sum, l) => sum + lineLength(l), 0);
  const longest = [...road.lines].sort((a, b) => lineLength(b) - lineLength(a))[0];
  const wikipedia = wikipediaTitle(road.tags);
  candidates.push({
    id: `road/${name}`,
    name,
    kind: "road",
    base: road.base,
    tags: road.tags,
    centre: midpoint(longest),
    lines: road.lines,
    size: length,
    wikidata: road.tags.wikidata,
    wikipedia,
    score:
      road.base +
      clamp(Math.log10(length / 300), -2, 2) +
      (wikipedia ? WIKIPEDIA_BONUS : 0),
  });
}
console.error(`${candidates.length} named candidates inside boundary`);

const dropped: string[] = [];
function drop(c: Candidate, why: string) {
  dropped.push(
    `${c.score.toFixed(1).padStart(5)} ${c.kind.padEnd(18)} ${c.name.padEnd(50)} ${why}`
  );
}

const byScore = [...candidates].sort((a, b) => b.score - a.score || b.size - a.size);
const kept: Candidate[] = [];
for (const c of byScore) {
  if (c.score < CUTOFF) {
    drop(c, "below cutoff");
    continue;
  }
  const container = kept.find(
    (k) => k.polygon && k.size > c.size && inPolygon(c.centre, k.polygon)
  );
  if (container && !c.lines && !c.wikipedia) {
    drop(c, `inside ${container.name}`);
    continue;
  }
  const twin = kept.find(
    (k) =>
      k.kind === c.kind &&
      k.name.toLowerCase() === c.name.toLowerCase() &&
      metres(k.centre, c.centre) < 300
  );
  if (twin) {
    drop(c, `duplicate of ${twin.id}`);
    continue;
  }
  kept.push(c);
}

type Summary = { extract: string; url: string; image?: string };
const summaries: Record<string, Summary | null> =
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
    const summary: Summary = { extract: j.extract, url: j.content_urls.desktop.page };
    const image = commonsFileFromThumb(j.thumbnail?.source);
    if (image) summary.image = image;
    summaries[c.wikipedia] = summary;
  } else {
    console.error(`wikipedia ${res.status} for ${c.wikipedia}`);
    summaries[c.wikipedia] = null;
  }
}
writeFileSync(SUMMARY_CACHE, JSON.stringify(summaries, null, 1) + "\n");

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function roundRings(rings: Ring[]): Ring[] {
  return rings.map((r) => r.map(([lat, lng]) => [round6(lat), round6(lng)]));
}
function difficulty(score: number): number {
  if (score >= 9) return 1;
  if (score >= 7) return 2;
  return 3;
}

const places: Place[] = kept
  .map((c) => {
    const place: Place = {
      name: c.name,
      kind: c.kind,
      difficulty: difficulty(c.score),
      lat: round6(c.centre.lat),
      lng: round6(c.centre.lng),
    };
    if (c.tags["addr:street"]) place.street = c.tags["addr:street"];
    const summary = c.wikipedia ? summaries[c.wikipedia] : undefined;
    if (summary) {
      place.blurb = summary.extract;
      place.url = summary.url;
    }
    const commonsFile = wikidataImage(c.tags) ?? summary?.image;
    if (commonsFile) place.commonsFile = commonsFile;
    if (c.polygon) place.polygon = roundRings(c.polygon);
    if (c.lines) place.lines = roundRings(c.lines);
    return place;
  })
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(OUT_FILE, JSON.stringify(places) + "\n");

const counts: Record<string, number> = {};
for (const p of places) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
console.error(`\ndropped:\n${dropped.join("\n")}`);
console.error(
  `\nkept:\n${kept.map((c) => `${c.score.toFixed(1).padStart(5)} ${c.kind.padEnd(18)} ${c.name}`).join("\n")}`
);
console.error(
  `\nkept ${places.length} places, ${places.filter((p) => p.polygon).length} with polygons, ${places.filter((p) => p.lines).length} roads, ${places.filter((p) => p.url).length} with wikipedia, ${places.filter((p) => p.commonsFile).length} with photo`
);
console.error(
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}`)
    .join(", ")
);
