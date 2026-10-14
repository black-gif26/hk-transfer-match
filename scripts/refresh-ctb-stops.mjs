import { mkdir, writeFile } from "node:fs/promises";

const CTB = "https://rt.data.gov.hk/v2/transport/citybus";
const OUT = new URL("../data/ctb-stops.json", import.meta.url);

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return out;
}

async function getJson(url) {
  let last = "unknown";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    last = `${res.status} ${url}`;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error(last);
}

const routes = (await getJson(`${CTB}/route/CTB`)).data;
const jobs = [];
for (const route of routes) {
  jobs.push([route.route, "outbound"]);
  jobs.push([route.route, "inbound"]);
}

const lists = await pool(jobs, 20, async ([route, dir]) => {
  try {
    const json = await getJson(`${CTB}/route-stop/CTB/${encodeURIComponent(route)}/${dir}`);
    return json.data.map((row) => row.stop);
  } catch (err) {
    console.log("route-stop fail", route, dir, err.message);
    return [];
  }
});

const ids = [...new Set(lists.flat().filter(Boolean))];
console.log("routes", routes.length, "stops", ids.length);
const stops = {};
await pool(ids, 20, async (id) => {
  const json = await getJson(`${CTB}/stop/${encodeURIComponent(id)}`);
  const row = json.data;
  stops[id] = [row.name_tc, row.name_en, Number(row.lat), Number(row.long)];
});

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: CTB,
    stops,
  }),
);
console.log("wrote", Object.keys(stops).length);
