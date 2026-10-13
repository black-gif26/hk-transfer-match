const state = {
  1: { routes: [], stops: [] },
  2: { routes: [], stops: [] },
};

const $ = (id) => document.getElementById(id);

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function parseRouteValue(value) {
  if (!value) return null;
  return JSON.parse(value);
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-HK", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Hong_Kong",
  });
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { Accept: "application/json", ...(options?.body ? { "Content-Type": "application/json" } : {}) },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `請求失敗 ${res.status}`);
  return data;
}

async function loadRoutes(leg) {
  const co = $(`co${leg}`).value;
  const q = $(`routeQuery${leg}`).value.trim();
  const select = $(`route${leg}`);
  const stopSelect = $(`stop${leg}`);

  if (!q) {
    select.innerHTML = `<option value="">先輸入路線</option>`;
    select.disabled = true;
    stopSelect.innerHTML = `<option value="">選路線後載入車站</option>`;
    stopSelect.disabled = true;
    state[leg].routes = [];
    state[leg].stops = [];
    return;
  }

  select.disabled = true;
  select.innerHTML = `<option value="">載入路線中…</option>`;

  try {
    const { routes } = await api(`/api/routes?co=${encodeURIComponent(co)}&q=${encodeURIComponent(q)}`);
    state[leg].routes = routes;
    if (!routes.length) {
      select.innerHTML = `<option value="">搵唔到路線</option>`;
      return;
    }
    select.innerHTML = routes
      .map(
        (r, i) =>
          `<option value='${JSON.stringify({
            co: r.co,
            route: r.route,
            bound: r.bound,
            serviceType: r.serviceType,
          })}'>${r.labelTc}</option>`,
      )
      .join("");
    select.disabled = false;
    await loadStops(leg);
  } catch (err) {
    select.innerHTML = `<option value="">載入失敗</option>`;
    showError(err.message);
  }
}

async function loadStops(leg, preferredStopId = null) {
  const route = parseRouteValue($(`route${leg}`).value);
  const stopSelect = $(`stop${leg}`);
  if (!route) {
    stopSelect.innerHTML = `<option value="">選路線後載入車站</option>`;
    stopSelect.disabled = true;
    return;
  }

  stopSelect.disabled = true;
  stopSelect.innerHTML = `<option value="">載入車站中…</option>`;

  const params = new URLSearchParams({
    co: route.co,
    route: route.route,
    bound: route.bound,
    serviceType: route.serviceType,
  });

  try {
    const { stops } = await api(`/api/stops?${params}`);
    state[leg].stops = stops;
    if (!stops.length) {
      stopSelect.innerHTML = `<option value="">呢個方向暫時無站</option>`;
      return;
    }
    stopSelect.innerHTML = stops
      .map((s) => `<option value="${s.stopId}">${s.seq}. ${s.nameTc}</option>`)
      .join("");
    stopSelect.disabled = false;
    if (preferredStopId && stops.some((s) => s.stopId === preferredStopId)) {
      stopSelect.value = preferredStopId;
    }
  } catch (err) {
    stopSelect.innerHTML = `<option value="">載入失敗</option>`;
    showError(err.message);
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("呢部機唔支援定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 30000,
    });
  });
}

function geoErrorMessage(err) {
  if (!err) return "定位失敗";
  if (err.code === 1) return "未授權定位。請喺 Safari 設定允許位置，再用 HTTPS 開呢個網站。";
  if (err.code === 2) return "暫時拎唔到位置，稍後再試。";
  if (err.code === 3) return "定位逾時，請再試一次。";
  return err.message || "定位失敗";
}

async function locateNearby() {
  const btn = $("locateBtn");
  const list = $("nearbyList");
  btn.disabled = true;
  btn.textContent = "定位中…";
  list.innerHTML = `<p class="hint">正在拎你個位置…</p>`;

  try {
    const pos = await getCurrentPosition();
    const { latitude: lat, longitude: long } = pos.coords;
    $("nearbyHint").textContent = `已定位：${lat.toFixed(5)}, ${long.toFixed(5)}`;
    list.innerHTML = `<p class="hint">搵緊附近車站…</p>`;

    const params = new URLSearchParams({
      lat: String(lat),
      long: String(long),
      limit: "12",
      maxMeters: "900",
    });
    const data = await api(`/api/nearby?${params}`);
    renderNearby(data);
  } catch (err) {
    list.innerHTML = `<div class="error">${geoErrorMessage(err)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "用我個位置";
  }
}

function renderNearby(data) {
  const list = $("nearbyList");
  if (!data.stops?.length) {
    list.innerHTML = `<p class="hint">附近 900 米暫時搵唔到九巴站。可試喺更近馬路再定位。</p>`;
    return;
  }

  $("nearbyHint").textContent = data.noteTc || "點開車站揀路線，再填入轉乘。";
  list.innerHTML = data.stops
    .map(
      (s, idx) => `
      <details class="nearby-stop" data-co="${s.co}" data-stop="${s.stopId}" ${idx === 0 ? "open" : ""}>
        <summary>
          <span>${s.nameTc}</span>
          <span class="dist">${s.meters}m · 約 ${s.walkMinutes} 分</span>
        </summary>
        <div class="service-list" data-services>載入路線中…</div>
      </details>
    `,
    )
    .join("");

  list.querySelectorAll("details.nearby-stop").forEach((el) => {
    const load = () => loadStopServices(el);
    el.addEventListener("toggle", () => {
      if (el.open) load();
    });
    if (el.open) load();
  });
}

async function loadStopServices(detailsEl) {
  const box = detailsEl.querySelector("[data-services]");
  if (!box || box.dataset.loaded === "1") return;
  const co = detailsEl.dataset.co;
  const stopId = detailsEl.dataset.stop;
  box.textContent = "載入路線中…";

  try {
    const { services } = await api(
      `/api/stop-services?co=${encodeURIComponent(co)}&stopId=${encodeURIComponent(stopId)}`,
    );
    box.dataset.loaded = "1";
    if (!services.length) {
      box.innerHTML = `<p class="hint">呢站暫時未有 ETA／路線。</p>`;
      return;
    }
    box.innerHTML = services
      .map((svc) => {
        const payload = encodeURIComponent(
          JSON.stringify({
            co,
            stopId,
            route: svc.route,
            bound: svc.bound,
            serviceType: svc.serviceType,
            destTc: svc.destTc,
          }),
        );
        return `
          <div class="service-row">
            <p><strong>${svc.route}</strong> → ${svc.destTc}${svc.nextEta ? ` · 下一班 ${fmtTime(svc.nextEta)}` : ""}</p>
            <div class="service-actions">
              <button type="button" class="chip-btn" data-apply="1" data-payload="${payload}">用作第一程落車</button>
              <button type="button" class="chip-btn" data-apply="2" data-payload="${payload}">用作第二程上車</button>
            </div>
          </div>
        `;
      })
      .join("");

    box.querySelectorAll("[data-apply]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const leg = Number(btn.dataset.apply);
        const payload = JSON.parse(decodeURIComponent(btn.dataset.payload));
        btn.disabled = true;
        try {
          await applyNearbyToLeg(leg, payload);
        } catch (err) {
          showError(err.message);
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="error">${err.message}</div>`;
  }
}

async function applyNearbyToLeg(leg, payload) {
  $(`co${leg}`).value = payload.co;
  $(`routeQuery${leg}`).value = payload.route;
  await loadRoutes(leg);

  const select = $(`route${leg}`);
  const wanted = JSON.stringify({
    co: payload.co,
    route: payload.route,
    bound: payload.bound,
    serviceType: payload.serviceType,
  });

  let matched = false;
  for (const opt of select.options) {
    if (opt.value === wanted) {
      select.value = opt.value;
      matched = true;
      break;
    }
  }
  if (!matched) {
    // Fallback: match route+bound even if serviceType string differs
    for (const opt of select.options) {
      if (!opt.value) continue;
      try {
        const v = JSON.parse(opt.value);
        if (v.route === payload.route && v.bound === payload.bound) {
          select.value = opt.value;
          matched = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (!matched) throw new Error(`搵唔到路線 ${payload.route} 對應方向`);

  await loadStops(leg, payload.stopId);
  $("nearbyHint").textContent =
    leg === 1
      ? `已填入第一程落車：${payload.route} → ${payload.destTc}`
      : `已填入第二程上車：${payload.route} → ${payload.destTc}`;
}

function showError(message) {
  $("result").innerHTML = `<div class="error">${message}</div>`;
}

function renderResult(data) {
  const pairsHtml = data.pairs
    .map((p, idx) => {
      const cls = p.status === "miss" ? "miss" : p.status === "tight" ? "tight" : "";
      const waitText =
        p.status === "miss"
          ? "接唔到可見班次"
          : `落地後再等約 ${p.waitMinutes} 分鐘（總相隔 ${p.gapMinutes} 分鐘）`;
      return `
        <article class="pair ${cls}" style="animation-delay:${idx * 40}ms">
          <div class="pair-top">
            <strong>${p.statusTc}</strong>
            <span>${waitText}</span>
          </div>
          <div class="times">
            <div>① 落車 ETA：${fmtTime(p.leg1Eta)}</div>
            <div>步行+緩衝後可上車：${fmtTime(p.readyAt)}</div>
            <div>② 上車 ETA：${p.leg2Eta ? fmtTime(p.leg2Eta) : "—"}</div>
          </div>
        </article>
      `;
    })
    .join("");

  $("result").innerHTML = `
    <div class="summary">
      <span class="pill ${data.hasMatch ? "match" : "nomatch"}">
        ${data.hasMatch ? "有 Match" : "未 Match"}
      </span>
      <p>${data.summaryTc}</p>
    </div>
    <p class="hint">${data.distanceHintTc} · 今次用步行 ${data.walkMinutes} 分 + 緩衝 ${data.bufferMinutes} 分</p>
    <div class="pairs">${pairsHtml || "<p class='hint'>未有組合可顯示。</p>"}</div>
  `;
  $("walkHint").textContent = data.distanceHintTc;
  if (!$("walkMinutes").value) {
    $("walkMinutes").placeholder = `估算 ${data.estimatedWalkMinutes}`;
  }
}

async function runMatch() {
  const route1 = parseRouteValue($("route1").value);
  const route2 = parseRouteValue($("route2").value);
  const stop1 = $("stop1").value;
  const stop2 = $("stop2").value;

  if (!route1 || !route2 || !stop1 || !stop2) {
    showError("請先揀齊兩程路線同車站。");
    return;
  }

  const walkRaw = $("walkMinutes").value;
  const bufferRaw = $("bufferMinutes").value;
  const payload = {
    leg1: { ...route1, stopId: stop1 },
    leg2: { ...route2, stopId: stop2 },
    walkMinutes: walkRaw === "" ? null : Number(walkRaw),
    bufferMinutes: bufferRaw === "" ? 1 : Number(bufferRaw),
  };

  const btn = $("matchBtn");
  btn.disabled = true;
  btn.textContent = "對緊時間…";
  $("result").innerHTML = `<p class="hint">拉取緊即時 ETA…</p>`;

  try {
    const data = await api("/api/match", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    renderResult(data);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "檢查轉乘時間";
  }
}

function wireLeg(leg) {
  const loadRoutesDebounced = debounce(() => loadRoutes(leg), 350);
  $(`co${leg}`).addEventListener("change", () => {
    $(`routeQuery${leg}`).value = "";
    loadRoutes(leg);
  });
  $(`routeQuery${leg}`).addEventListener("input", loadRoutesDebounced);
  $(`route${leg}`).addEventListener("change", () => loadStops(leg));
}

wireLeg(1);
wireLeg(2);
$("matchBtn").addEventListener("click", runMatch);
$("locateBtn").addEventListener("click", locateNearby);

// Soft defaults so first open already shows something to try
$("routeQuery1").value = "1A";
$("routeQuery2").value = "5";
loadRoutes(1).then(() => loadRoutes(2));
