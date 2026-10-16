# 駁車時（hk-transfer-match）

香港巴士 **兩程轉乘** 小工具：定出發地、揀兩程路線，列出可步行轉乘站，再對照即時 ETA 估算接駁時間。

## 核心原則

應用會分開三件事：

1. **物理轉乘可行性** — 路線／方向／站序／直線步行距離是否合理
2. **即時班次是否可見** — 公開 ETA 清單有冇相關班次
3. **估算接駁是否兼容** — 可見時間喺假設下是否趕得切

**空嘅第二程 ETA，或者可見班次都太早，唔等於無法轉乘或已收車。** 相關第二程可能仲未入顯示範圍。

## 上車方式

- **使用目前位置（可選）**：建議最近第一程上車站同步行時間；定位失敗唔會鎖死流程。
- **自行選擇上車站**：由所選路線／方向揀上車站（含站序）；可填「幾分鐘後到上車站」。唔填則趕得切未核實，唔當 0 分。

## 時間狀態（TimingStatus）

| 狀態 | 意思 |
| --- | --- |
| `eta_matched` | 可見時間兼容（估算／未核實同一架車） |
| `awaiting_board1_eta` | 已有轉車站，第一程上車時間待更新 |
| `awaiting_leg1_eta` | 已有轉車站，第一程落車時間待更新 |
| `awaiting_leg2_eta` | 可喺此轉車，第二程班次待更新 |
| `outside_visible_eta` | 目前可見班次未能配對，稍後再查 |
| `no_catchable_board1` | 可見第一程班次未能趕上（唔會自動改揀趕唔切嘅車） |
| `manual_uncatchable` | 人手揀嘅班次可能趕唔切 |
| `preferred_gone` | 人手揀�切嘅車） |
| `manual_uncatchable` | 人手揀嘅班次可能趕唔切 |
| `preferred_gone` | 人手揀嘅班次已唔喺可見列表（唔會默默換車） |
| `upstream_error` | 班次資料暫時無法讀取 |

`hasMatch` 只係 `timingStatus === "eta_matched"` 嘅窄義兼容旗標，唔代表物理可行性。

## ETA 限制

- 公開 KMB／Citybus ETA 沒有穩定跨站 trip／vehicle id；唔會當成已核實「同一架車」。
- `eta_matched` = 可見時間喺假設下兼容，唔係保證轉乘。
- 落車時間可能用站距啟發式過濾過早 ETA，並標明 `estimated_unverified`。
- 轉車距離係直線估算，唔代表實際可行人路。
- 唔會發明第二程開出時間；唔會用未驗證�verified`。
- 轉車距離係直線估算，唔代表實際可行人路。
- 唔會發明第二程開出時間；唔會用未驗證嘅班距／時間表估算冒充即時 ETA。

## 模式

- **最少步行**：按直線轉車距離排序；冇 ETA 都照顯示較短選項。
- **最早上車**：有可用估算時間嘅候選按第二程上車時間排序；未知時間另外按步行距離列出。「最快」指最早上第二程，唔係最早到終點。搜尋可能有上限並會標明。
- **人手揀站**：列出物理候選，唔因 ETA 缺失而隱藏。

## 本機跑

```bash
npm install --legacy-peer-deps
npm run dev
```

開 `http://127.0.0.1:8787`

```bash
npm run typecheck
npm test
```

## API

- `GET /api/routes?co=KMB|CTB&q=1A`
- `GET /api/stops?co=KMB&route=1A&bound=O&serviceType=1`
- `GET /api/nearby?lat=22.29&long=114.17`
- `POST /api/board1-departures` — 第一程可見班次（含可否趕上）
- `POST /api/plan-transfer` — `origin` + 兩程 + `mode` + 可選 `preferredBoard1Eta`
- `POST /api/refresh-candidate` — 保留選定轉車站，只更新受約束�-candidate` — 保留選定轉車站，只更新受約束嘅計時
- `POST /api/match` — 站對站時間對照（進階；計劃結果唔會用佢取代已選候選）

無效輸入回傳 **400**；上游失敗回傳 **502／504**（唔會洩露上游 URL）。

## 資料來源

- [KMB/LWB ETA](https://data.gov.hk/en-data/dataset/hk-td-tis_21-etakmb)
- [Citybus Next Bus](https://data.gov.hk/en-data/dataset/ctb-eta-transport-realtime-eta)

## 已知限制

- 城巴附近站目錄唔完整
- 直線步行／啟發式行車時間
- 最快模式評估數量有上限
- 手動改進階轉車站會取消舊時間軸，需重新揀候選
