# 駁車時（hk-transfer-match）

香港巴士 **兩程轉乘時間 match** 小工具（v0.1）。

揀第一程落車站、第二程上車站，拉 KMB / Citybus 即時 ETA，計你行過去之後仲夠唔夠時間駁第二程。

## 功能（第一版）

- 支援九巴／龍運（KMB）同城巴（CTB）
- 兩程車：落車 ETA → 步行 + 緩衝 → 對第二程 ETA
- **出發地定位**後揀兩程路線，再選轉乘站模式：
  1. 最少轉乘步行距離
  2. 最快轉乘站（即時 ETA）
  3. 人手選擇轉乘站
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

- `GET /api/routes?co=KMB|CTB&q=1A`
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
