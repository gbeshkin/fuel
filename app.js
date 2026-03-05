
const LATEST_URL = "./data/latest.json";
const PREV_URL   = "./data/prev.json";
const META_URL   = "./data/meta.json";

const els = {
  city: document.getElementById("citySelect"),
  fuel: document.getElementById("fuelSelect"),
  company: document.getElementById("companySelect"), // NEW (может быть null)
  sort: document.getElementById("sortSelect"),       // NEW (может быть null)
  q: document.getElementById("q"),
  refresh: document.getElementById("refreshBtn"),
  meta: document.getElementById("meta"),
  tbody: document.querySelector("#tblStations tbody") // если в новом HTML таблица tblStations
        || document.querySelector("#tbl tbody"),      // fallback на старый id
};

let map;
let markersLayer;

let allRows = [];      
let stationIndex = [];
let prevPriceByKey = new Map(); // key -> price

function safeStr(v) {
  return (v === null || v === undefined) ? "" : String(v);
}

function escapeHtml(s) {
  return safeStr(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toCityFromAddress(address) {
  const s = safeStr(address);
  const parts = s.split(",").map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 1];
  return "";
}

function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "";
  return Number(n).toFixed(3);
}

function ensureMap() {
  if (map) return;

  map = L.map("map", { zoomControl: true }).setView([59.437, 24.753], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

function priceKey(row) {
  return `${row.stationId}::${row.fuelTypeId}`;
}

function compareTrend(row) {
  const prev = prevPriceByKey.get(priceKey(row));
  const curr = row.price;

  if (typeof curr !== "number" || typeof prev !== "number") {
    return { icon: "—", text: "нет данных", cls: "trendNone" };
  }

  const diff = curr - prev;
  const eps = 0.0005; // чтобы 1.5690000002 не считалось ростом

  if (diff > eps)  return { icon: "↑", text: `+${diff.toFixed(3)}`, cls: "trendUp" };
  if (diff < -eps) return { icon: "↓", text: `${diff.toFixed(3)}`, cls: "trendDown" };
  return { icon: "→", text: "0.000", cls: "trendFlat" };
}

function getFilterState() {
  return {
    city: els.city.value,
    fuel: els.fuel.value,
    q: els.q.value.trim().toLowerCase(),
  };
}

function applyFilters(rows) {
  const { city, fuel, q } = getFilterState();

  return rows.filter(r => {
    if (city !== "__ALL__" && r.city !== city) return false;
    if (fuel !== "__ALL__" && r.fuelName !== fuel) return false;

    if (q) {
      const hay = `${safeStr(r.stationName)} ${safeStr(r.address)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function buildFilters(rows) {
  const cities = new Set();
  const fuels = new Set();

  for (const r of rows) {
    if (r.city) cities.add(r.city);
    if (r.fuelName) fuels.add(r.fuelName);
  }

  const cityList = Array.from(cities).sort((a, b) => a.localeCompare(b));
  const fuelList = Array.from(fuels).sort((a, b) => a.localeCompare(b));

  els.city.innerHTML =
    `<option value="__ALL__">Все</option>` +
    cityList.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  els.fuel.innerHTML =
    `<option value="__ALL__">Все</option>` +
    fuelList.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
}

function unpackFuelest(json) {
  const priceInfo = json?.data?.priceInfo ?? [];
  const rows = [];
  const stationsById = new Map();

  for (const companyBlock of priceInfo) {
    const companyId = companyBlock.companyId;
    const stationInfos = companyBlock.stationInfos ?? [];

    for (const st of stationInfos) {
      const city = toCityFromAddress(st.address);

      if (!stationsById.has(st.stationId)) {
        stationsById.set(st.stationId, {
          stationId: st.stationId,
          displayName: st.displayName,
          address: st.address,
          city,
          latitude: st.latitude,
          longitude: st.longitude,
          countyId: st.countyId,
          companyId,
        });
      }

      const fuelInfos = st.fuelInfos ?? [];
      for (const f of fuelInfos) {
        const address = f.address ?? st.address;
        rows.push({
          companyId: f.companyId ?? companyId,
          stationId: f.stationId ?? st.stationId,
          stationName: f.displayName ?? st.displayName,
          address,
          city: toCityFromAddress(address),
          latitude: f.latitude ?? st.latitude,
          longitude: f.longitude ?? st.longitude,
          fuelName: f.name,
          fuelTypeId: f.fuelTypeId,
          price: f.price,
          currency: f.currency,
          dateTime: f.dateTime,
        });
      }
    }
  }

  return { rows, stations: Array.from(stationsById.values()) };
}

async function fetchJsonOrNull(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchData() {
  els.meta.textContent = "Загружаю данные…";

  const latestJson = await fetchJsonOrNull(LATEST_URL);
  if (!latestJson) {
    throw new Error("Не удалось загрузить data/latest.json. Запусти GitHub Actions хотя бы один раз.");
  }

  const prevJson = await fetchJsonOrNull(PREV_URL);
  const metaJson = await fetchJsonOrNull(META_URL);

  // latest
  const latest = unpackFuelest(latestJson);
  allRows = latest.rows;
  stationIndex = latest.stations;

  // prev map
  prevPriceByKey = new Map();
  if (prevJson) {
    const prev = unpackFuelest(prevJson).rows;
    for (const r of prev) {
      if (typeof r.price === "number") {
        prevPriceByKey.set(priceKey(r), r.price);
      }
    }
  }

  buildFilters(allRows);

  const updatedAt = metaJson?.updated_at_utc
    ? new Date(metaJson.updated_at_utc).toLocaleString("ru-RU")
    : new Date().toLocaleString("ru-RU");

  const hasPrev = prevPriceByKey.size > 0;
  els.meta.textContent =
    `Записей: ${allRows.length}. Станций: ${stationIndex.length}. ` +
    `Последнее обновление (UTC): ${updatedAt}. `;
  

  render();
}

function renderTable(filteredRows) {
  const html = filteredRows
    .slice()
    .sort((a, b) => {
      const c = safeStr(a.city).localeCompare(safeStr(b.city));
      if (c !== 0) return c;
      const s = safeStr(a.stationName).localeCompare(safeStr(b.stationName));
      if (s !== 0) return s;
      return safeStr(a.fuelName).localeCompare(safeStr(b.fuelName));
    })
    .map(r => {
      const dt = r.dateTime ? new Date(r.dateTime).toLocaleString("ru-RU") : "";
      const t = compareTrend(r);

      return `<tr>
        <td class="small">${escapeHtml(r.companyId)}</td>
        <td>${escapeHtml(r.stationName)}</td>
        <td>${escapeHtml(r.address)}</td>
        <td>${escapeHtml(r.city)}</td>
        <td>${escapeHtml(r.fuelName)}</td>
        <td><b>${escapeHtml(fmtPrice(r.price))}</b> ${escapeHtml(r.currency || "")}</td>
        <td class="small">${escapeHtml(dt)}</td>
        <td class="${t.cls}">
          ${escapeHtml(t.icon)} <span class="small trendText">${escapeHtml(t.text)}</span>
        </td>
      </tr>`;
    })
    .join("");

  els.tbody.innerHTML = html || `<tr><td colspan="8" class="small">Нет данных под выбранные фильтры</td></tr>`;
}

function renderMap(filteredRows) {
  ensureMap();
  markersLayer.clearLayers();

  const stationIds = new Set(filteredRows.map(r => r.stationId));

  const byStation = new Map();
  for (const r of filteredRows) {
    const arr = byStation.get(r.stationId) ?? [];
    arr.push(r);
    byStation.set(r.stationId, arr);
  }

  const bounds = [];

  for (const st of stationIndex) {
    if (!stationIds.has(st.stationId)) continue;
    if (typeof st.latitude !== "number" || typeof st.longitude !== "number") continue;

    const rows = (byStation.get(st.stationId) ?? [])
      .slice()
      .sort((a, b) => safeStr(a.fuelName).localeCompare(safeStr(b.fuelName)));

    const lines = rows.map(r => {
      const dt = r.dateTime ? new Date(r.dateTime).toLocaleString("ru-RU") : "";
      const t = compareTrend(r);
      return `<div>
        <b>${escapeHtml(r.fuelName)}</b>:
        ${escapeHtml(fmtPrice(r.price))} ${escapeHtml(r.currency || "")}
        <span class="small">(${escapeHtml(dt)})</span>
        <span class="small"> — <b>${escapeHtml(t.icon)}</b> ${escapeHtml(t.text)}</span>
      </div>`;
    }).join("");

    const popup = `
      <div style="min-width:240px">
        <div><b>${escapeHtml(st.displayName || "")}</b></div>
        <div class="small">${escapeHtml(st.address || "")}</div>
        <div class="small">Город: ${escapeHtml(st.city || "")}</div>
        <hr style="border:0;border-top:1px solid rgba(255,255,255,.18);margin:8px 0"/>
        ${lines || "<div class='small'>Нет цен</div>"}
      </div>
    `;

    const m = L.marker([st.latitude, st.longitude]).bindPopup(popup);
    markersLayer.addLayer(m);
    bounds.push([st.latitude, st.longitude]);
  }

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function render() {
  const filtered = applyFilters(allRows);
  renderTable(filtered);
  renderMap(filtered);
}

function on(el, event, handler) {
  if (el) el.addEventListener(event, handler);
}

function bindUI() {
  on(els.city, "change", render);
  on(els.fuel, "change", render);
  on(els.company, "change", render);   // если добавил companySelect
  on(els.sort, "change", render);      // если добавил sortSelect

  on(els.q, "input", () => {
    window.clearTimeout(window.__t);
    window.__t = window.setTimeout(render, 120);
  });

  on(els.refresh, "click", () => fetchData().catch(showErr));
}

function showErr(e) {
  console.error(e);
  els.meta.textContent = `Ошибка: ${e?.message || e}`;
}

(async function main() {
  bindUI();
  try {
    await fetchData();
  } catch (e) {
    showErr(e);
  }
})();
