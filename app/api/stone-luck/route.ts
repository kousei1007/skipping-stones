import { getStage } from "@/game/stages";
import { replayThrow, validateSubmission, type ThrowSubmission } from "@/game/verify";
import { clientIpHash, secretThrowSeed, verifyPlayToken } from "@/lib/playToken";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

/** 前の投擲の飛行時間に足す、次の投擲までの最短の間隔 [秒]。画面では着水後の 1.8 秒とゲージ 3 回（約 1.5 秒）がかかる */
const MIN_GAP_S = 2.5;
/** 投擲番号を飛ばしてよい数（通信の失敗で番号がずれたときのため） */
const MAX_SKIPPED_THROWS = 10;
/** 同じ接続元から受け付ける投擲の数（1 分あたり） */
const THROWS_PER_MINUTE = 20;

const REJECTED: Record<string, [number, string]> = {
  "no-session": [401, "プレイの情報が見つかりません。ステージに入り直してください"],
  "too-soon": [429, "前の投擲がまだ終わっていません"],
  "bad-index": [409, "投擲の順番が正しくありません"],
  "rate-limited": [429, "短い時間に投げすぎています"],
  "stone-used": [409, "この石はすでに投げています"],
};

const reject = (reason: string) => {
  const [status, error] = REJECTED[reason] ?? [500, "通信に失敗しました"];
  return Response.json({ error }, { status });
};

/**
 * 投げた瞬間に呼ぶ。投げ方をここで確定させ、サーバーが結果を計算して保存してから、投擲の乱数の種を返す。
 * 記録（/api/scores）はここで保存した結果だけを使うので、外れた投擲を取り消して引き直すことはできない。
 */
export async function POST(request: Request) {
  let body: { token?: unknown; throw?: ThrowSubmission };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const claims = verifyPlayToken(body.token);
  if (!claims) return Response.json({ error: "プレイの情報が無効か、期限が切れています" }, { status: 401 });

  const stage = getStage(claims.stage);
  const sub = body.throw;
  const invalid = sub ? validateSubmission(stage, sub) : "投擲の情報がありません";
  if (invalid || !sub) return Response.json({ error: invalid }, { status: 400 });

  const supabase = getSupabaseAdmin();
  if (!supabase) return Response.json({ error: "オンラインランキングは無効です" }, { status: 503 });

  // 明らかに受け付けられない投擲は、物理計算の前に断る（最終的な判定は reveal_throw の中でロックして行う）。
  // 時刻はサーバーと DB で時計が少しずれることがあるので、正しい投擲をここで弾かないよう 1 秒の余裕を持たせる
  const { data: play, error: playError } = await supabase
    .from("play_sessions")
    .select("last_throw_index, next_throw_at")
    .eq("id", claims.sid)
    .maybeSingle();
  if (playError) {
    console.error("play session fetch failed", playError.message);
    return reject("");
  }
  if (!play) return reject("no-session");
  if (Date.parse(play.next_throw_at) > Date.now() + 1000) return reject("too-soon");
  if (sub.throwIndex <= play.last_throw_index || sub.throwIndex > play.last_throw_index + 1 + MAX_SKIPPED_THROWS) return reject("bad-index");

  const seed = secretThrowSeed(claims, sub);
  const result = replayThrow(stage, claims, sub, seed);

  const { data: outcome, error } = await supabase.rpc("reveal_throw", {
    p_session_id: claims.sid,
    p_throw_index: sub.throwIndex,
    p_max_skip: MAX_SKIPPED_THROWS,
    p_min_gap_s: MIN_GAP_S,
    p_ip_hash: clientIpHash(request),
    p_ip_limit: THROWS_PER_MINUTE,
    p_stone_serial: sub.stoneSerial,
    p_bounces: result.bounces,
    p_distance: result.distance,
    p_weather: result.weather,
    p_end_t: result.endT,
  });
  if (error) {
    console.error("throw reveal failed", error.message);
    return reject("");
  }
  if (outcome !== "ok") return reject(String(outcome));
  return Response.json({ seed });
}
