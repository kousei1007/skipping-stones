import { randomSeed } from "@/game/rng";
import type { ScoreRecord, StageId } from "@/game/types";
import { HIDDEN_SCORE_IDS, RANKING_SINCE, RANKING_SIZE, type PlaySeeds, type ThrowSubmission } from "@/game/verify";
import { getSupabase } from "./supabase";

const LOCAL_KEY = "skipping-stones:scores";
const NAME_KEY = "skipping-stones:player-name";

function readLocal(): ScoreRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as ScoreRecord[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(records: ScoreRecord[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(records.slice(-300)));
  } catch {
    // 保存できない環境では何もしない
  }
}

export const isOnline = () => getSupabase() !== null;

/** オンライン記録用の署名付きプレイ情報（端末保存のときは token が null） */
export interface PlaySession extends PlaySeeds {
  token: string | null;
  /** オンラインで遊べなかった理由（サーバーに断られたとき） */
  notice?: string;
}

/** ステージに入るときに、サーバーから河原・天候の種をもらう。使えないときは端末だけで遊ぶ */
export async function startPlay(stageId: StageId): Promise<PlaySession> {
  let notice: string | undefined;
  if (isOnline()) {
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId }),
      });
      if (res.ok) return (await res.json()) as PlaySession;
      if (res.status === 429) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        notice = `${error ?? "混み合っています"}（今回の記録は端末に保存されます）`;
      }
    } catch {
      // 通信できないときは端末保存に切り替える
    }
  }
  return { token: null, fieldSeed: randomSeed(), condSeed: randomSeed(), notice };
}

/**
 * 投げた瞬間に、投擲の乱数の種（当たり外れ・炎・ブレ）をサーバーに決めてもらう（同じ投擲につき 1 回だけ）。
 * 断られたときは理由を返す（その投擲はオンラインに記録しない）
 */
export async function fetchThrowSeed(token: string, submission: ThrowSubmission): Promise<{ seed: number } | { error: string }> {
  try {
    const res = await fetch("/api/stone-luck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, throw: submission }),
    });
    const { seed, error } = (await res.json().catch(() => ({}))) as { seed?: unknown; error?: unknown };
    if (res.ok && typeof seed === "number") return { seed };
    if (typeof error === "string") return { error: `${error}（この投擲はオンラインに記録されません）` };
  } catch {
    // 通信できないときは端末だけで投げる
  }
  return { error: "通信できなかったため、この投擲はオンラインに記録されません" };
}

/**
 * 記録を保存する。オンラインでは「どう投げたか」だけを送り、跳ねた回数はサーバーが計算し直す。
 * データベースへブラウザから直接書き込むことはしない。
 */
export async function saveScore(record: ScoreRecord, token: string | null, submission: ThrowSubmission): Promise<void> {
  if (isOnline() && token) {
    const res = await fetch("/api/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, playerName: record.player_name, throw: submission }),
    });
    if (res.ok) return;
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error ?? "記録に失敗しました");
  }
  writeLocal([...readLocal(), { ...record, id: crypto.randomUUID(), created_at: new Date().toISOString() }]);
}

export async function fetchTopScores(stageId: StageId, limit = RANKING_SIZE): Promise<ScoreRecord[]> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase
      .from("scores")
      .select("id, player_name, stage_id, bounces, distance, weather, created_at")
      .eq("stage_id", stageId)
      .gte("created_at", RANKING_SINCE)
      .not("id", "in", `(${HIDDEN_SCORE_IDS.join(",")})`)
      .order("bounces", { ascending: false })
      .order("distance", { ascending: false })
      .limit(limit);
    if (!error && data) return data as ScoreRecord[];
    console.warn("Supabase からの取得に失敗したため端末の記録を表示します", error?.message);
  }
  return readLocal()
    .filter((r) => r.stage_id === stageId && Date.parse(r.created_at ?? "") >= Date.parse(RANKING_SINCE) && !HIDDEN_SCORE_IDS.includes(r.id ?? ""))
    .sort((a, b) => b.bounces - a.bounces || b.distance - a.distance)
    .slice(0, limit);
}

export function loadPlayerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storePlayerName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // 無視
  }
}
