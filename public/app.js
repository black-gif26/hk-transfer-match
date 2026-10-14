const state = {
  1: { routes: [], stops: [] },
  2: { routes: [], stops: [] },
  origin: null,
  plan: null,
  selectedCandidateIndex: null,
  match: null,
};

const $ = (id) => document.getElementById(id);

const MODE_HINTS = {
  shortest_walk: "優先轉車兩站距離最短。",
  fastest: "由出發地計到第二程最早上車時間。",
  manual: "列出可揀站，你自己決定；可開進階睇附近站。",
};

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function parseRouteValue(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("zh-HK", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Hong_Kong",
  });
}

function selectedMode() {
  return document.querySelector('input[name="planMode"]:checked')?.value || "shortest_walk";
}

function setStep(n) {
  document.querySelectorAll(".step").forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle("is-current", s === n);
    el.classList.toggle("is-done", s < n);
  });
  $("cardOrigin").classList.toggle("is-ready", !!state.origin);
  $("cardRoutes").classList.toggle("is-dim", !state.origin);
  $("cardRoutes").classList.toggle("is-ready", !!state.origin);
  $("cardPlan").classList.toggle("is-dim", !canPlan());
  $("cardPlan").classList.toggle("is-ready", canPlan());
}

function canPlan() {
  return !!(state.origin && parseRouteValue($("route1").value) && parseRouteValue($("route2").value));
}

function refreshSticky() {
  const btn = $("planBtn");
  if (!state.origin) {
    $("stickyHint").textContent = "先分享位置";
    btn.disabled = true;
    btn.textContent = "開始搵轉乘";
    setStep(1);
    return;
  }
  if (!parseRouteValue($("route1").value) || !parseRouteValue($("route2").value)) {
    $("stickyHint").textContent = "再揀兩程路線同方向";
    btn.disabled = true;
    btn.textContent = "開始搵轉乘";
    setStep(2);
    return;
  }
  $("stickyHint").textContent = "可以開始搵轉乘建議";
  btn.disabled = false;
  btn.textContent = "開始搵轉乘";
  setStep(3);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: {
      Accept: "application/json",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `請求失敗 ${res.status}`);
  return data;
}

function syncVisibleStops(leg) {
  const hidden = $(`stop${leg}`);
  const visible = $(`stop${leg}Visible`);
  visible.innerHTML = hidden.innerHTML;
  visible.disabled = hidden.disabled || !hidden.options.length;
  visible.value = hidden.value;
}

async function loadRoutes(leg) {
  const co = $(`co${leg}`).value;
  const q = $(`routeQuery${leg}`).value.trim();
  const select = $(`route${leg}`);
  const stopSelect = $(`stop${leg}`);

  if (!q) {
    select.innerHTML = `<option value="">輸入路線後揀方向</option>`;
    select.disabled = true;
    stopSelect.innerHTML = "";
    stopSelect.disabled = true;
    syncVisibleStops(leg);
    state[leg].routes = [];
    state[leg].stops = [];
    refreshSticky();
    return;
  }

  select.disabled = true;
  select.innerHTML = `<option value="">載入中…</option>`;

  try {
    const { routes } = await api(
      `/api/routes?co=${encodeURIComponent(co)}&q=${encodeURIComponent(q)}`,
    );
    state[leg].routes = routes;
    if (!routes.length) {
      select.innerHTML = `<option value="">搵唔到路線</option>`;
      refreshSticky();
      return;
    }
    select.innerHTML = routes
      .map(
        (r) =>
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
    showOutputError(err.message);
  }
  refreshSticky();
}

async function loadStops(leg, preferredStopId = null) {
  const route = parseRouteValue($(`route${leg}`).value);
  const stopSelect = $(`stop${leg}`);
  if (!route) {
    stopSelect.innerHTML = "";
    stopSelect.disabled = true;
    syncVisibleStops(leg);
    return;
  }

  stopSelect.disabled = true;
  const params = new URLSearchParams({
    co: route.co,
    route: route.route,
    bound: route.bound,
    serviceType: route.serviceType,
  });

  try {
    const { stops } = await api(`/api/stops?${params}`);
    state[leg].stops = stops;
    stopSelect.innerHTML = stops
      .map((s) => `<option value="${s.stopId}">${s.seq}. ${s.nameTc}</option>`)
      .join("");
    stopSelect.disabled = !stops.length;
    if (preferredStopId && stops.some((s) => s.stopId === preferredStopId)) {
      stopSelect.value = preferredStopId;
    }
  } catch (err) {
    stopSelect.innerHTML = `<option value="">載入失敗</option>`;
    showOutputError(err.message);
  }
  syncVisibleStops(leg);
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
  if (err.code === 1) return "未授權定位。請喺 Safari 允許位置，並用 HTTPS 開啟。";
  if (err.code === 2) return "暫時拎唔到位置，稍後再試。";
  if (err.code === 3) return "定位逾時，請再試一次。";
  return err.message || "定位失敗";
}

async function locateOrigin() {
  const btn = $("locateBtn");
  btn.disabled = true;
  btn.textContent = "定位中…";
  $("originStatus").textContent = "正在拎你個位置…";
  $("originStatus").classList.remove("ok");

  try {
    const pos = await getCurrentPosition();
    state.origin = { lat: pos.coords.latitude, long: pos.coords.longitude };
    $("originStatus").textContent = "已定位，可以揀兩程路線。";
    $("originStatus").classList.add("ok");
    btn.textContent = "重新定位";
    $("cardRoutes").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    $("originStatus").textContent = geoErrorMessage(err);
    btn.textContent = "分享位置開始";
  } finally {
    btn.disabled = false;
    refreshSticky();
  }
}

function showOutputError(message) {
  $("output").innerHTML = `<div class="error">${message}</div>`;
}

function renderMatchInline(data) {
  if (!data) return "";
  const best = data.pairs.find((p) => p.status !== "miss") || data.pairs[0];
  if (!best) return "";
  const cls = best.status === "miss" ? "miss" : best.status === "tight" ? "tight" : "";
  return `
    <article class="pair ${cls}">
      <div class="pair-top">
        <strong>${data.hasMatch ? "時間 Match" : "未 Match"} · ${best.statusTc}</strong>
      </div>
      <div class="times">
        <div>落車 ${fmtTime(best.leg1Eta)}</div>
        <div>可行上第二程 ${fmtTime(best.readyAt)}</div>
        <div>第二程上車 ${best.leg2Eta ? fmtTime(best.leg2Eta) : "—"}</div>
      </div>
    </article>
  `;
}

async function runMatchQuiet() {
  const route1 = parseRouteValue($("route1").value);
  const route2 = parseRouteValue($("route2").value);
  const stop1 = $("stop1").value;
  const stop2 = $("stop2").value;
  if (!route1 || !route2 || !stop1 || !stop2) return null;

  const walkRaw = $("walkMinutes").value;
  const bufferRaw = $("bufferMinutes").value;
  return api("/api/match", {
    method: "POST",
    body: JSON.stringify({
      leg1: { ...route1, stopId: stop1 },
      leg2: { ...route2, stopId: stop2 },
      walkMinutes: walkRaw === "" ? null : Number(walkRaw),
      bufferMinutes: bufferRaw === "" ? 1 : Number(bufferRaw),
    }),
  });
}

async function applyCandidate(index) {
  const plan = state.plan;
  if (!plan?.candidates?.[index]) return;
  const c = plan.candidates[index];
  state.selectedCandidateIndex = index;

  await Promise.all([loadStops(1, c.alight1.stopId), loadStops(2, c.board2.stopId)]);
  $("walkMinutes").value = String(c.walkMinutes);

  try {
    state.match = await runMatchQuiet();
  } catch (err) {
    state.match = null;
    showOutputError(err.message);
  }
  renderOutput();
}

function renderOutput() {
  const plan = state.plan;
  const box = $("output");
  if (!plan) {
    box.innerHTML = "";
    return;
  }
  if (!plan.candidates.length) {
    box.innerHTML = `<div class="error">${plan.summaryTc}</div>`;
    return;
  }

  const modeLabel =
    plan.mode === "fastest" ? "最早上車" : plan.mode === "manual" ? "人手揀" : "最少步行";

  const selected = state.selectedCandidateIndex;
  const selectedCard =
    selected != null && plan.candidates[selected]
      ? `
      <div class="timeline">
        <strong>已選轉乘</strong>
        <div>① ${fmtTime(plan.candidates[selected].board1Eta)} 上第一程（${plan.board1.nameTc}）</div>
        <div>↓ ${plan.candidates[selected].alight1.nameTc}</div>
        <div>↓ 步行約 ${plan.candidates[selected].walkMeters}m</div>
        <div>② ${fmtTime(plan.candidates[selected].leg2Eta)} 上第二程（${plan.candidates[selected].board2.nameTc}）</div>
      </div>
      ${renderMatchInline(state.match)}
    `
      : `<p class="hint">撳下面其中一個建議，就會顯示時間。</p>`;

  box.innerHTML = `
    <div class="summary">
      <span class="pill match">${modeLabel}</span>
      <p>${plan.summaryTc}</p>
    </div>
    ${selectedCard}
    <div class="plan-result">
      ${plan.candidates
        .map((c, idx) => {
          const isSelected = selected === idx;
          return `
          <article class="candidate ${isSelected ? "selected" : ""}" role="button" tabindex="0" data-pick="${idx}">
            <div class="candidate-top">
              <strong>${isSelected ? "已選 · " : ""}#${idx + 1}</strong>
              <span>${c.hasMatch ? "可接" : "未接"}</span>
            </div>
            <p class="meta-line">${c.scoreTc}</p>
            <p class="meta-line">落：${c.alight1.nameTc}</p>
            <p class="meta-line">上：${c.board2.nameTc}</p>
          </article>
        `;
        })
        .join("")}
    </div>
  `;

  box.querySelectorAll("[data-pick]").forEach((el) => {
    const pick = async () => {
      el.style.opacity = "0.7";
      try {
        await applyCandidate(Number(el.dataset.pick));
        $("output").scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (err) {
        showOutputError(err.message);
      }
    };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
  });
}

async function loadNearbyList() {
  if (!state.origin) return;
  const list = $("nearbyList");
  $("nearbyBlock").hidden = false;
  list.innerHTML = `<p class="hint">搵緊附近車站…</p>`;
  try {
    const params = new URLSearchParams({
      lat: String(state.origin.lat),
      long: String(state.origin.long),
      limit: "10",
      maxMeters: "900",
    });
    const data = await api(`/api/nearby?${params}`);
    renderNearby(data);
  } catch (err) {
    list.innerHTML = `<div class="error">${err.message}</div>`;
  }
}

function renderNearby(data) {
  const list = $("nearbyList");
  if (!data.stops?.length) {
    list.innerHTML = `<p class="hint">附近暫時搵唔到站。</p>`;
    return;
  }
  $("nearbyHint").textContent = "點開車站，填入落車／上車站。";
  list.innerHTML = data.stops
    .map(
      (s) => `
      <details class="nearby-stop" data-co="${s.co}" data-stop="${s.stopId}">
        <summary>
          <span>${s.nameTc}</span>
          <span class="dist">${s.meters}m</span>
        </summary>
        <div class="service-list" data-services>載入路線中…</div>
      </details>
    `,
    )
    .join("");

  list.querySelectorAll("details.nearby-stop").forEach((el) => {
    el.addEventListener("toggle", () => {
      if (el.open) loadStopServices(el);
    });
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
      box.innerHTML = `<p class="hint">呢站暫時未有路線。</p>`;
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
            <p><strong>${svc.route}</strong> → ${svc.destTc}</p>
            <div class="service-actions">
              <button type="button" class="chip-btn" data-apply="1" data-payload="${payload}">第一程落車</button>
              <button type="button" class="chip-btn" data-apply="2" data-payload="${payload}">第二程上車</button>
            </div>
          </div>
        `;
      })
      .join("");
    box.querySelectorAll("[data-apply]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const leg = Number(btn.dataset.apply);
        const payload = JSON.parse(decodeURIComponent(btn.dataset.payload));
        $(`co${leg}`).value = payload.co;
        $(`routeQuery${leg}`).value = payload.route;
        await loadRoutes(leg);
        const select = $(`route${leg}`);
        for (const opt of select.options) {
          if (!opt.value) continue;
          const v = JSON.parse(opt.value);
          if (v.route === payload.route && v.bound === payload.bound) {
            select.value = opt.value;
            break;
          }
        }
        await loadStops(leg, payload.stopId);
        refreshSticky();
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="error">${err.message}</div>`;
  }
}

async function runPlan() {
  if (!canPlan()) {
    showOutputError("請先完成定位同兩程路線。");
    return;
  }

  const btn = $("planBtn");
  btn.disabled = true;
  btn.textContent = "搵緊…";
  $("stickyHint").textContent = "分析緊轉乘站同 ETA";
  $("output").innerHTML = `<p class="hint">分析緊兩程車站同即時 ETA…</p>`;
  state.selectedCandidateIndex = null;
  state.match = null;

  const mode = selectedMode();
  try {
    const plan = await api("/api/plan-transfer", {
      method: "POST",
      body: JSON.stringify({
        origin: state.origin,
        leg1: parseRouteValue($("route1").value),
        leg2: parseRouteValue($("route2").value),
        mode,
        maxTransferMeters: Number($("maxTransferMeters").value || 450),
        bufferMinutes: Number($("bufferMinutes").value || 1),
        limit: mode === "manual" ? 12 : 8,
      }),
    });
    state.plan = plan;
    renderOutput();

    if (mode === "manual") {
      $("advanced").open = true;
      await loadNearbyList();
    } else if (plan.candidates.length) {
      const firstGood = plan.candidates.findIndex((c) => c.hasMatch);
      await applyCandidate(firstGood >= 0 ? firstGood : 0);
    }

    $("output").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showOutputError(err.message);
  } finally {
    refreshSticky();
    btn.textContent = "再搵一次";
  }
}

function wireLeg(leg) {
  const loadRoutesDebounced = debounce(() => loadRoutes(leg), 350);
  $(`co${leg}`).addEventListener("change", () => {
    $(`routeQuery${leg}`).value = "";
    loadRoutes(leg);
  });
  $(`routeQuery${leg}`).addEventListener("input", loadRoutesDebounced);
  $(`route${leg}`).addEventListener("change", async () => {
    await loadStops(leg);
    refreshSticky();
  });
  $(`stop${leg}Visible`).addEventListener("change", async () => {
    $(`stop${leg}`).value = $(`stop${leg}Visible`).value;
    if (state.plan && state.selectedCandidateIndex != null) {
      try {
        state.match = await runMatchQuiet();
        renderOutput();
      } catch (err) {
        showOutputError(err.message);
      }
    }
  });
}

document.querySelectorAll('input[name="planMode"]').forEach((input) => {
  input.addEventListener("change", () => {
    $("modeHint").textContent = MODE_HINTS[selectedMode()];
    $("nearbyBlock").hidden = selectedMode() !== "manual";
    if (selectedMode() === "manual" && state.origin) {
      $("advanced").open = true;
      loadNearbyList();
    }
  });
});

wireLeg(1);
wireLeg(2);
$("locateBtn").addEventListener("click", locateOrigin);
$("planBtn").addEventListener("click", runPlan);

$("modeHint").textContent = MODE_HINTS.shortest_walk;
refreshSticky();
