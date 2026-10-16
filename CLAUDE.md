# CLAUDE.md

川で石を投げて跳ねた回数を競う 3D 水切りゲーム。Next.js 16 (App Router) + TypeScript 7 + three.js。

## コマンド

- `npm run dev` — 開発サーバー（http://localhost:3000）
- `npm run build` / `npm start` — 本番ビルドと起動
- `npm run typecheck` — 型チェック（`tsc --noEmit`）

テストランナーはない。物理の調整を確かめるときは `src/game/*.ts` を一時ディレクトリへ CommonJS で出力し、Node で `simulateThrow` を回して跳ねた回数の平均を比べる:

```bash
npx tsc src/game/physics.ts src/game/conditions.ts --outDir <tmp> --module commonjs --target es2022 --skipLibCheck --ignoreConfig
```

## 守ること（ユーザー指定の UI ルール）

- アイコンは Lucide（`lucide-react`）だけ。絵文字は使わない
- 左ボーダーのアクセントカード（`border-left` で色を付けたカード）は禁止
- デザインは Material Design 3 と Human Interface Guidelines を参考にする。色・形・文字サイズは `app/globals.css` の `--md-*` トークンとクラス（`.btn--filled`、`.sheet`、`.title-m` など）を使い、値を直書きしない
- フロントは TypeScript + Next.js。サーバー側が必要になったら Supabase を使う
- UI の文言は日本語

## 構成

- `src/game/` — 描画に依存しない純粋なゲームロジック
  - `stages.ts` 3 ステージの定義と川の形（中心線・川幅・流速）。座標は「川は +x 方向へ流れ、手前岸が +z 側、対岸へ投げる向きが -z」
  - `terrain.ts` 地形の高さ `terrainHeight`。**描画と物理の両方が使う**ので、変えると当たり判定も変わる
  - `stones.ts` 石の生成・品質（薄さ 28% / 底面 25% / 丸み 25% / 重さ 22%）・追加ルール `canAddStones`
  - `conditions.ts` 天候・風・流れ。雨の日は風と流れが強くなりやすい
  - `physics.ts` 投擲シミュレーション。投げた瞬間に軌道を全部計算し、`ThrowResult`（軌道サンプル・バウンド・終了理由）を返す
- `src/three/` — three.js の描画。`GameScene.ts` がシーン全体とカメラを管理し、React からは `setStage` / `setStones` / `setMode` / `setThrow` / `startFlight` で操作する
- `src/components/` — UI。`GameRoot.tsx` が画面の状態遷移（title → select → position → aim → power → flight → result）を持つ
- `src/lib/` — スコア保存。`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` があれば Supabase、なければ localStorage。`playToken.ts`・`supabaseAdmin.ts` はサーバー専用
- `app/api/session`・`app/api/stone-luck`・`app/api/scores` — ランキングの不正対策。サーバーがプレイの種（河原・天候）に署名して発行し、`play_sessions` に記録する。投げた瞬間に `stone-luck` が投げ方を受け取り、`src/game/verify.ts` の `replayThrow` で跳ねた回数を計算して `throw_reveals` に保存してから、秘密の鍵で決めた投擲の乱数の種を返す。`scores` は保存済みの結果だけを書き込む（投げ方を変えて引き直せない）。投擲番号は前にしか進まず、前の投擲の飛行時間 + 2.5 秒は次を受け付けない。接続元（IP の鍵付きハッシュ）ごとにプレイ発行と投擲の回数を制限する。名前は同じプレイの中では最初に記録したものに固定（端末でも一度記録した名前は変えられない）
- `supabase/migrations/` — `scores`・`throw_reveals`・`play_sessions` と RLS（`scores` は表示用の列だけ誰でも閲覧可。書き込みはサーバーの service_role だけ）

## 仕様上の数値

- ゲージは 1 回最大 1000、3 回合計で最大 3000（`MAX_GAUGE_PER_ROUND`）。数値はユーザーに見せない
- 石の追加は「追加後に上限を超えるなら不可」（ちょうど上限は可）。追加は 100 個単位（`addBatch`）で、今いる場所の周り（±8m）の隙間に置く。追加した石の通し番号は `ADD_SERIAL_BASE` から追加した順に続ける（サーバーは「上限 − 初期の数 + 投げた数」を超える番号を受け付けない）
- 石は河原の上流〜下流（`MOVE_RANGE` 全体）に地面が見えないほど敷き詰める（格子 `STONE_FIELD.grid`、1 万個以上）。石選びでは ← → / A D / 画面のボタンを押している間だけ歩き（Shift で走る）、カメラは `throwX` の位置を映す
- 河原の石は 1 個ずつのメッシュにせず、形の種類（12 種）× 8m 区画ごとの `InstancedMesh` で描く。拾った石だけ `buildStoneGeometry` で正確な形を作る
- ゲージはクリック／キーを押したイベントの時刻で値を決め、表示もその場で固定する
- 固定の最適解を作らないため、石には見た目でわからない当たり外れ（0.90〜1.04 倍）があり、投げるたびに角度・向き・力が少しブレる。投擲の乱数（当たり外れ・炎・ブレ・水面の乱れ）はすべて、投げた瞬間にサーバーの鍵から決まる種（`secretThrowSeed`）で作るので、サーバーの再計算と一致する。この種を河原・天候の種から計算できるようにしてはいけない（できると石ごとの回数を前もって計算できてしまう）
- 物理の目安: 全条件 MAX（理想の石かつ当たり・ゲージ 3000・低角度・穏やかな水面、川幅の広い大河）で約 100 回、良い石で約 20 回、普通の石 5〜9 回、分厚い・重すぎる石 0 回。調整後はこの幅が保たれているか確認する（理想の石に近いほど減衰が 1 に近づくため、`retention` の係数は少し変えるだけで回数が大きく変わる）
- 1%（`FIRE_CHANCE`）の確率で炎の石になり、跳ねる回数が予定のちょうど 2 倍になる（沈む・対岸に届くはずの時点から下流へ小刻みに跳ね続ける）。当たりは投擲の乱数の種から決めるので、サーバーの再計算と一致する
- 石の選択中はカメラをマウスに追従させない（画面が揺れて酔うため）

## 注意点

- three.js は r186。`THREE.Clock` は非推奨なので `THREE.Timer`、`PCFSoftShadowMap` は削除済みなので `PCFShadowMap` を使う
- three.js は `GameRoot` の `useEffect` 内で動的 import している（SSR で読み込まない）
- 石は見やすさのため実寸の `STONE_VISUAL_SCALE`（1.8 倍）で描く。物理は実寸
- 描画負荷対策として、木・草・小石は区画ごとの `InstancedMesh`（`ChunkedInstances`）にして視錐台カリングを効かせている。細かい物は `userData.skipReflection` で水面の反射から外している
- 水面は `three/examples` の `Water` のシェーダーを文字列置換で改造している（流れによる模様の移動・近距離の歪み抑制）。three を更新したら置換対象の文字列が残っているか確認する
- 開発時のみ `window.__game`（シーン）と `window.__throw(values)`（ゲージ値を指定して投げる）がデバッグ用に使える
- **秘密情報**: `SUPABASE_SERVICE_ROLE_KEY` と `SCORE_SIGNING_SECRET` はサーバー専用。`NEXT_PUBLIC_` を付けない、クライアントのコードから import しない、リポジトリに書かない（`.env.local` か Vercel の環境変数に置く）
- 石の見た目の性質・天候はプレイの種から決定的に作る（`stoneFromSerial`・`conditionsAt`）。ブラウザとサーバーで結果が一致しないと記録が食い違うので、乱数の使い方を変えるときは両方の一致を確認する
- Windows 環境。`python` コマンドは Microsoft Store のスタブで止まるので使わない
