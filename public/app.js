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

async function loadStops(leg) {
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
  } catch (err) {
    stopSelect.innerHTML = `<option value="">載入失敗</option>`;
    showError(err.message);
  }
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

// Soft defaults so first open already shows something to try
$("routeQuery1").value = "1A";
$("routeQuery2").value = "5";
loadRoutes(1).then(() => loadRoutes(2));
