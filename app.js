const LATEST_URL = "./data/latest.json";
const PREV_URL = "./data/prev.json";
const META_URL = "./data/meta.json";

const els = {
  cityInput: document.getElementById("cityInput"),
  cityList: document.getElementById("cityList"),
  company: document.getElementById("companySelect"),
  sort: document.getElementById("sortSelect"),
  q: document.getElementById("q"),
  refresh: document.getElementById("refreshBtn"),
  meta: document.getElementById("meta"),

  badgeUpdated: document.getElementById("badgeUpdated"),
  badgeCity: document.getElementById("badgeCity"),

  tbody:
    document.querySelector("#tblStations tbody") ||
    document.querySelector("#tbl tbody"),
};

let map;
let markersLayer;
let markerByStationId = new Map();

let rawRowsLatest = [];       
let stationsLatest = [];      
let prevPriceByKey = new Map(); 

let stationRows = []; // [{stationId, stationName, address, city, companyId, lat, lon, prices:{p95,p98,diesel,lpg,cng}, deltas:{...}, stationDeltaObj:{icon,text,cls,abs}}]

const FUEL_KEYS = ["p95", "p98", "diesel", "lpg", "cng"];
const FUEL_LABEL = {
  p95: "95",
  p98: "98",
  diesel: "Diesel",
  lpg: "LPG",
  cng: "CNG",
};

function safeStr(v) {
  return v === null || v === undefined ? "" : String(v);
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
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 1];
  return "";
}

function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(3);
}

function priceKey(stationId, fuelTypeId) {
  return `${stationId}::${fuelTypeId}`;
}

function normalizeFuelKey(fuelName) {
  const n = safeStr(fuelName).toLowerCase();

  if (n.includes("cng")) return "cng";
  if (n.includes("lpg")) return "lpg";
  if (n.includes("diesel") || n.includes("diisel")) return "diesel";

  
  if (/(^|\D)98(\D|$)/.test(n)) return "p98";
  if (/(^|\D)95(\D|$)/.test(n)) return "p95";

  return null;
}

function compareTrendByRow(stationId, fuelTypeId, currPrice) {
  const prev = prevPriceByKey.get(priceKey(stationId, fuelTypeId));
  const curr = currPrice;

  if (typeof curr !== "number" || typeof prev !== "number") {
    return { icon: "—", text: "нет данных", cls: "deltaNone", abs: null, diff: null };
  }

  const diff = curr - prev;
  const eps = 0.0005;

  if (diff > eps) return { icon: "↑", text: `+${diff.toFixed(3)}`, cls: "deltaUp", abs: Math.abs(diff), diff };
  if (diff < -eps) return { icon: "↓", text: `${diff.toFixed(3)}`, cls: "deltaDown", abs: Math.abs(diff), diff };
  return { icon: "→", text: "0.000", cls: "deltaFlat", abs: 0, diff: 0 };
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

function unpackFuelest(json) {
  const priceInfo = json?.data?.priceInfo ?? [];
  const rows = [];
  const stationsById = new Map();

  for (const companyBlock of priceInfo) {
    const companyId = companyBlock.companyId;
    const stationInfos = companyBlock.stationInfos ?? [];

    for (const st of stationInfos) {
      const address = st.address;
      const city = toCityFromAddress(address);

      if (!stationsById.has(st.stationId)) {
        stationsById.set(st.stationId, {
          stationId: st.stationId,
          displayName: st.displayName,
          address,
          city,
          latitude: st.latitude,
          longitude: st.longitude,
          countyId: st.countyId,
          companyId,
        });
      }

      const fuelInfos = st.fuelInfos ?? [];
      for (const f of fuelInfos) {
        const rowAddress = f.address ?? address;
        rows.push({
          companyId: f.companyId ?? companyId,
          stationId: f.stationId ?? st.stationId,
          stationName: f.displayName ?? st.displayName,
          address: rowAddress,
          city: toCityFromAddress(rowAddress),
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

function buildPrevPriceMap(prevRows) {
  const m = new Map();
  for (const r of prevRows) {
    if (typeof r.price === "number") {
      m.set(priceKey(r.stationId, r.fuelTypeId), r.price);
    }
  }
  return m;
}

function buildStationRowsFromLatest(latestRows) {
  const byStation = new Map();

  for (const r of latestRows) {
    const sid = r.stationId;
    const key = normalizeFuelKey(r.fuelName);
    if (!key) continue;

    const obj = byStation.get(sid) ?? {
      stationId: sid,
      stationName: r.stationName,
      address: r.address,
      city: r.city,
      companyId: r.companyId,
      latitude: r.latitude,
      longitude: r.longitude,
      prices: { p95: null, p98: null, diesel: null, lpg: null, cng: null },
      deltas: { p95: null, p98: null, diesel: null, lpg: null, cng: null },
      fuelTypeIdByKey: { p95: null, p98: null, diesel: null, lpg: null, cng: null },
      currency: r.currency || "",
      dateTime: r.dateTime || "",
    };

    if (typeof r.price === "number") {
      const curr = obj.prices[key];
      if (curr === null || curr === undefined || (typeof curr === "number" && r.price < curr)) {
        obj.prices[key] = r.price;
        obj.fuelTypeIdByKey[key] = r.fuelTypeId;
      }
    }

    if (!obj.stationName) obj.stationName = r.stationName;
    if (!obj.address) obj.address = r.address;
    if (!obj.city) obj.city = r.city;

    byStation.set(sid, obj);
  }

  const out = [];
  for (const st of byStation.values()) {
    for (const fk of FUEL_KEYS) {
      const ftid = st.fuelTypeIdByKey[fk];
      const price = st.prices[fk];
      if (ftid && typeof price === "number") {
        st.deltas[fk] = compareTrendByRow(st.stationId, ftid, price);
      } else {
        st.deltas[fk] = { icon: "—", text: "нет данных", cls: "deltaNone", abs: null, diff: null };
      }
    }

    let best = { icon: "—", text: "нет данных", cls: "deltaNone", abs: null, diff: null };
    for (const fk of FUEL_KEYS) {
      const d = st.deltas[fk];
      if (typeof d?.abs === "number") {
        if (best.abs === null || d.abs > best.abs) best = d;
      }
    }

    st.stationDeltaObj = best;

    out.push(st);
  }

  return out;
}

function uniqSorted(arr) {
  return Array.from(new Set(arr.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function buildFilters() {
  const cities = Array.from(new Set(stationRows.map(s => s.city)))
    .filter(Boolean)
    .sort();
  if (els.cityList) {
    els.cityList.innerHTML =
      `<option value="Все"></option>` +
      cities.map(c =>
        `<option value="${escapeHtml(c)}"></option>`
      ).join("");
    }
  }

  const companies = uniqSorted(stationRows.map((s) => safeStr(s.companyId)));
  if (els.company) {
    const current = els.company.value || "__ALL__";
    els.company.innerHTML =
      `<option value="__ALL__">Все</option>` +
      companies.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    els.company.value = companies.includes(current) ? current : "__ALL__";
  }


function getFilterState() {
  return {
    city: els.cityInput ? els.cityInput.value : "Все",
    company: els.company ? els.company.value : "__ALL__",
    sort: els.sort ? els.sort.value : "station",
    q: els.q ? els.q.value.trim().toLowerCase() : "",
  };
}

function passesFilters(st) {
  const { city, company, q } = getFilterState();

  if (city && city !== "Все" && st.city !== city) return false;
  if (company !== "__ALL__" && safeStr(st.companyId) !== company) return false;

  if (q) {
    const hay = `${safeStr(st.stationName)} ${safeStr(st.address)}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }

  return true;
}

function sortStations(list) {
  const { sort } = getFilterState();

  const getPrice = (s, key) => {
    const v = s.prices[key];
    return typeof v === "number" ? v : Number.POSITIVE_INFINITY;
  };

  const getDeltaAbs = (s) => {
    const v = s.stationDeltaObj?.abs;
    return typeof v === "number" ? v : -1;
  };

  const sorted = list.slice();

  if (sort === "p95") {
    sorted.sort((a, b) => getPrice(a, "p95") - getPrice(b, "p95"));
  } else if (sort === "p98") {
    sorted.sort((a, b) => getPrice(a, "p98") - getPrice(b, "p98"));
  } else if (sort === "diesel") {
    sorted.sort((a, b) => getPrice(a, "diesel") - getPrice(b, "diesel"));
  } else if (sort === "delta") {
    sorted.sort((a, b) => getDeltaAbs(b) - getDeltaAbs(a));
  } else {
    // station
    sorted.sort((a, b) => safeStr(a.stationName).localeCompare(safeStr(b.stationName)));
  }

  return sorted;
}

function renderBadges(metaUpdatedAt) {
  if (els.badgeUpdated) {
    els.badgeUpdated.textContent = metaUpdatedAt ? `Обновлено: ${metaUpdatedAt}` : "—";
  }
  if (els.badgeCity) {
    const { city } = getFilterState();
    els.badgeCity.textContent = city === "__ALL__" ? "Все города" : city;
  }
}

function renderMetaLine(metaUpdatedAt) {
  const count = stationRows.filter(passesFilters).length;
  const hasPrev = prevPriceByKey.size > 0;

  if (els.meta) {
    els.meta.textContent =
      `Станций (после фильтров): ${count}. ` +
      (metaUpdatedAt ? `Последнее обновление (UTC): ${metaUpdatedAt}. ` : "") +
      (hasPrev ? "Δ активно (сравнение с прошлым обновлением)." : "Δ появится после следующего обновления (когда появится prev.json).");
  }
}

function renderTable() {
  if (!els.tbody) return;

  const filtered = stationRows.filter(passesFilters);
  const sorted = sortStations(filtered);

  const cellPrice = (s, key) => {
    const price = s.prices[key];
    const val = typeof price === "number" ? fmtPrice(price) : "—";
    return `<div class="price">
      <span class="priceVal">${escapeHtml(val)}</span>
    </div>`;
  };

  const deltaCell = (s) => {
    const d = s.stationDeltaObj || { icon: "—", text: "нет данных", cls: "deltaNone" };
    return `<div class="delta ${escapeHtml(d.cls)}">
      <span>${escapeHtml(d.icon)}</span>
      <span class="deltaText">${escapeHtml(d.text)}</span>
    </div>`;
  };

  const html = sorted
    .map((s) => {
      return `<tr data-station-id="${escapeHtml(s.stationId)}">
        <td class="col-station">
          <div style="display:flex;flex-direction:column;gap:3px;">
            <div style="font-weight:800;">${escapeHtml(s.stationName)}</div>
            <div class="small" style="opacity:.9;">${escapeHtml(s.address)}</div>
          </div>
        </td>
        <td class="col-city">${escapeHtml(s.city)}</td>
        <td class="col-fuel">${cellPrice(s, "p95")}</td>
        <td class="col-fuel">${cellPrice(s, "p98")}</td>
        <td class="col-fuel">${cellPrice(s, "diesel")}</td>
        <td class="col-fuel">${cellPrice(s, "lpg")}</td>
        <td class="col-fuel">${cellPrice(s, "cng")}</td>
        <td class="col-delta">${deltaCell(s)}</td>
      </tr>`;
    })
    .join("");

  els.tbody.innerHTML =
    html ||
    `<tr><td colspan="8" class="small" style="padding:14px;">Нет данных под выбранные фильтры</td></tr>`;

  els.tbody.querySelectorAll("tr[data-station-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const sid = tr.getAttribute("data-station-id");
      focusStationOnMap(sid);
    });
  });
}

function renderMap() {
  ensureMap();
  markersLayer.clearLayers();
  markerByStationId = new Map();

  const filtered = stationRows.filter(passesFilters);

  const bounds = [];
  for (const s of filtered) {
    if (typeof s.latitude !== "number" || typeof s.longitude !== "number") continue;

    const popup = `
      <div style="min-width:260px">
        <div><b>${escapeHtml(s.stationName)}</b></div>
        <div class="small">${escapeHtml(s.address)}</div>
        <div class="small">Город: ${escapeHtml(s.city)}</div>
        <hr style="border:0;border-top:1px solid rgba(255,255,255,.18);margin:8px 0"/>

        ${FUEL_KEYS.map((k) => {
          const p = s.prices[k];
          const val = typeof p === "number" ? fmtPrice(p) : "—";
          const d = s.deltas[k] || { icon: "—", text: "нет данных" };
          return `<div>
            <b>${escapeHtml(FUEL_LABEL[k])}</b>: ${escapeHtml(val)}
            <span class="small"> — <b>${escapeHtml(d.icon)}</b> ${escapeHtml(d.text)}</span>
          </div>`;
        }).join("")}
      </div>
    `;

    const m = L.marker([s.latitude, s.longitude]).bindPopup(popup);
    markersLayer.addLayer(m);
    markerByStationId.set(s.stationId, m);
    bounds.push([s.latitude, s.longitude]);
  }

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function focusStationOnMap(stationId) {
  if (!stationId) return;
  ensureMap();

  const m = markerByStationId.get(stationId);
  if (m) {
    const latlng = m.getLatLng();
    map.setView(latlng, Math.max(map.getZoom(), 14), { animate: true });
    m.openPopup();
    return;
  }

  const s = stationRows.find((x) => x.stationId === stationId);
  if (s && typeof s.latitude === "number" && typeof s.longitude === "number") {
    map.setView([s.latitude, s.longitude], 14, { animate: true });
  }
}

function renderAll(metaUpdatedAt) {
  renderBadges(metaUpdatedAt);
  renderMetaLine(metaUpdatedAt);
  renderTable();
  renderMap();
}

function on(el, event, handler) {
  if (el) el.addEventListener(event, handler);
}

function bindUI(metaUpdatedAtRef) {
  on(els.city, "change", () => {
    renderBadges(metaUpdatedAtRef.value);
    renderMetaLine(metaUpdatedAtRef.value);
    renderTable();
    renderMap();
  });

  on(els.company, "change", () => {
    renderBadges(metaUpdatedAtRef.value);
    renderMetaLine(metaUpdatedAtRef.value);
    renderTable();
    renderMap();
  });

  on(els.sort, "change", () => {
    renderTable();
  });

  on(els.q, "input", () => {
    window.clearTimeout(window.__t);
    window.__t = window.setTimeout(() => {
      renderBadges(metaUpdatedAtRef.value);
      renderMetaLine(metaUpdatedAtRef.value);
      renderTable();
      renderMap();
    }, 120);
  });

  on(els.refresh, "click", () => {
    fetchData().catch(showErr);
  });
}

function showErr(e) {
  console.error(e);
  if (els.meta) {
    els.meta.textContent = `Ошибка: ${e?.message || e}`;
  }
  if (els.badgeUpdated) els.badgeUpdated.textContent = "Ошибка";
}

async function fetchData() {
  if (els.meta) els.meta.textContent = "Загружаю данные…";

  const latestJson = await fetchJsonOrNull(LATEST_URL);
  if (!latestJson) {
    throw new Error("Не удалось загрузить data/latest.json. Проверь, что GitHub Actions создал файл и он доступен в Pages.");
  }

  const prevJson = await fetchJsonOrNull(PREV_URL);
  const metaJson = await fetchJsonOrNull(META_URL);

  const latest = unpackFuelest(latestJson);
  rawRowsLatest = latest.rows;
  stationsLatest = latest.stations;

  prevPriceByKey = new Map();
  if (prevJson) {
    const prev = unpackFuelest(prevJson).rows;
    prevPriceByKey = buildPrevPriceMap(prev);
  }

  stationRows = buildStationRowsFromLatest(rawRowsLatest);

  const updatedAt = metaJson?.updated_at_utc
    ? new Date(metaJson.updated_at_utc).toLocaleString("ru-RU")
    : "";

  buildFilters();
  renderAll(updatedAt);

  return updatedAt;
}

(async function main() {
  const metaUpdatedAtRef = { value: "" };
  bindUI(metaUpdatedAtRef);

  try {
    metaUpdatedAtRef.value = await fetchData();
  } catch (e) {
    showErr(e);
  }
})();
