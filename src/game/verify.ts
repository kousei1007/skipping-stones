import { driftConditions, rollConditions } from "./conditions";
import { MAX_GAUGE_PER_ROUND, GAUGE_ROUNDS, simulateThrow, THROW_LIMITS } from "./physics";
import { deriveSeed } from "./rng";
import { MOVE_RANGE } from "./stages";
import { ADD_SERIAL_BASE, stoneFromSerial } from "./stones";
import type { Conditions, StageDef, Weather } from "./types";

/** ランキングに表示・記録できる順位（この順位以内に入った記録だけ保存する） */
export const RANKING_SIZE = 5;

/** ランキングの集計開始時刻。これより前の記録は表示も順位の比較もしない（記録自体は消さない） */
export const RANKING_SINCE = "2026-10-11T14:01:00Z";

/** ランキングの締め切り（日本時間 2026/10/31 23:59）。この時刻からは記録を受け付けない */
export const RANKING_UNTIL = "2026-10-31T14:59:00Z";

export const isRankingClosed = (now = Date.now()) => now >= Date.parse(RANKING_UNTIL);

/** ランキングから外した記録の id（データベースからは消さない。表示も順位の比較もしない） */
export const HIDDEN_SCORE_IDS: string[] = [
  "55c463d4-d324-401b-916b-c26fc3113ed6",
  "f8e6d762-83f7-42a7-8e99-44fd5763d26a",
  "7048f2be-3c87-4037-b058-0cd741defe90",
  "22a1d2a3-fd18-496f-b606-bbe04746ac67",
  "9f0007f8-8194-459d-9158-e800f9617f7b",
  "69074cdb-1255-4ce0-a01b-1aaed858139e",
  "c917b272-2727-4763-9238-4d28617fbbfa",
  "092f77f4-266e-4e7c-a81f-da6fd05a2d29",
  "e23355a8-7088-4bc0-a7ad-be72fc369f45",
  "f6646351-73f8-4196-a991-cb5d5371bdb8",
  "5235d737-d60b-478e-974d-7a915842392b",
  "458ae16a-58b3-4e6a-9fa8-8d43ee2d237a",
  "50d41ac7-bd2b-4e76-82fc-0e74c9ce3d95",
  "e2a28cfe-9e97-4424-bcc2-a4d14208858b",
  "501a1448-2bca-4754-879b-1d378bf3529e",
  "787d19c8-7010-47fc-9b7c-0fcb73b89e6e",
  "24ee457a-8e17-4252-8b89-ac53a5d149b2",
  "29e186c1-2b76-4b8d-a5d7-c6ab565d2410",
  "030d9556-cc84-427c-ba37-5a75b541f013",
  "2cad22f3-7ca0-4b47-81ab-8125fcfb7ca5",
];

/** 今の上位（跳ねた回数 → 飛距離の順に並んだもの）に入れるか。最下位と同じ記録では入れない */
export function entersTopRanking(top: { bounces: number; distance: number }[], bounces: number, distance: number): boolean {
  if (top.length < RANKING_SIZE) return true;
  const last = top[RANKING_SIZE - 1];
  const round = (d: number) => Math.round(d * 10) / 10;
  return bounces > last.bounces || (bounces === last.bounces && round(distance) > round(last.distance));
}

/**
 * 1 回のプレイ（ステージに入ってから出るまで）の乱数の種。
 * オンライン時はサーバーが発行・署名し、河原の石・天候・投擲の揺らぎをすべてここから決める。
 */
export interface PlaySeeds {
  fieldSeed: number;
  condSeed: number;
}

/** 記録のためにサーバーへ送る「どう投げたか」。跳ねた回数は送らない */
export interface ThrowSubmission {
  stoneSerial: number;
  throwIndex: number;
  originX: number;
  elevationDeg: number;
  yawDeg: number;
  gauge: number[];
}

/** throwIndex 回目の投擲時の天候（1 投ごとに決まった種で風が変わる） */
export function conditionsAt(stage: StageDef, condSeed: number, throwIndex: number): Conditions {
  let c = rollConditions(stage, condSeed);
  for (let j = 0; j < throwIndex; j++) c = driftConditions(stage, c, deriveSeed(condSeed, j));
  return c;
}

export const driftSeed = (condSeed: number, throwIndex: number) => deriveSeed(condSeed, throwIndex);

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isNum = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** 送られてきた投擲が、ゲーム内で実際に可能な範囲か */
export function validateSubmission(stage: StageDef, s: ThrowSubmission): string | null {
  if (!isInt(s.throwIndex, 0, 100_000)) return "投擲番号が不正です";
  // 河原の石は上限（maxStones）までしか増やせず、投げた石の分だけ追加できる。追加した石の通し番号は追加した順に続く
  const maxAdded = stage.maxStones - stage.initialStones + s.throwIndex;
  const serialOk =
    isInt(s.stoneSerial, 0, stage.initialStones - 1) || isInt(s.stoneSerial, ADD_SERIAL_BASE, ADD_SERIAL_BASE + maxAdded - 1);
  if (!serialOk) return "石が不正です";
  if (!isNum(s.originX, -MOVE_RANGE, MOVE_RANGE)) return "立ち位置が不正です";
  if (!isNum(s.elevationDeg, 0, THROW_LIMITS.elevationMax)) return "角度が不正です";
  if (!isNum(s.yawDeg, -THROW_LIMITS.yaw, THROW_LIMITS.yaw)) return "向きが不正です";
  if (!Array.isArray(s.gauge) || s.gauge.length !== GAUGE_ROUNDS || !s.gauge.every((g) => isInt(g, 0, MAX_GAUGE_PER_ROUND)))
    return "ゲージが不正です";
  return null;
}

/** 種と投げ方から投擲をやり直して、跳ねた回数を求める（ブラウザとサーバーで同じ計算）。seed は投擲の乱数の種（サーバーの鍵から決まる） */
export function replayThrow(
  stage: StageDef,
  seeds: PlaySeeds,
  s: ThrowSubmission,
  seed: number,
): { bounces: number; distance: number; weather: Weather; endT: number } {
  const conditions = conditionsAt(stage, seeds.condSeed, s.throwIndex);
  const result = simulateThrow({
    stone: stoneFromSerial(seeds.fieldSeed, s.stoneSerial),
    conditions,
    stage,
    originX: s.originX,
    elevationDeg: s.elevationDeg,
    yawDeg: s.yawDeg,
    power: s.gauge.reduce((a, b) => a + b, 0),
    seed,
  });
  return { bounces: result.bounces.length, distance: result.distance, weather: conditions.weather, endT: result.endT };
}
