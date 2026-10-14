# 駁車時（hk-transfer-match）

香港巴士 **兩程轉乘時間 match** 小工具（v0.1）。

搜兩程路線，用 KMB / Citybus 即時 ETA 睇轉乘時間。

## 點用

地圖式搜尋，唔使逐步揀公司、方向、模式：

1. 頁面會問一次位置（或者撳「用我的位置」）
2. 打第一程編號，撳一個建議（公司同方向已經喺度）
3. 打第二程，再撳一個建議

兩程一齊揀好，就會自動出最早轉乘。想睇少啲路，撳「最少步行」。時間、班次、落車站放喺「調整」。

## 功能

- 支援九巴／龍運（KMB）同城巴（CTB），一個搜尋框同時搵
- 兩程車：落車 ETA → 步行 + 緩衝 → 對第二程 ETA
- 預設用最早可上第二程嘅轉乘站，亦可改最少步行
- 自動用兩站座標估算步行分鐘（可人手改）
- 顯示每個組合係「充裕／啱啱好／好逼／接唔到」

## 本機跑

```bash
npm install --legacy-peer-deps
npm run dev
```

開 `http://127.0.0.1:8787`

## 部署

```bash
npx wrangler login
npm run deploy
```

## API

- `GET /api/routes?q=1A` — 同時搜九巴同城巴，可用 `limit`；加 `co=KMB|CTB` 就只搜一間
- `GET /api/stops?co=KMB&route=1A&bound=O&serviceType=1`
- `GET /api/nearby?lat=22.29&long=114.17&limit=12&maxMeters=900`
- `GET /api/stop-services?co=KMB&stopId=...`
- `POST /api/plan-transfer` — `origin` + 兩程路線 + `mode=shortest_walk|fastest|manual`
- `POST /api/match` — body 含 `leg1`、`leg2`、可選 `walkMinutes` / `bufferMinutes`

## 資料來源

- [KMB/LWB ETA](https://data.gov.hk/en-data/dataset/hk-td-tis_21-etakmb)
- [Citybus Next Bus](https://data.gov.hk/en-data/dataset/ctb-eta-transport-realtime-eta)

## 下一步

- 同站／附近站自動建議轉車點
- 三程以上車駁車
- MTR / 小巴
- 收藏常用轉乘組合
