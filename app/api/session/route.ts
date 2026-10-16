import { STAGES } from "@/game/stages";
import type { StageId } from "@/game/types";
import { clientIpHash, issuePlayToken } from "@/lib/playToken";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

/** 同じ接続元から発行できるプレイの数（SESSION_WINDOW_S 秒ごと） */
const SESSIONS_PER_WINDOW = 30;
const SESSION_WINDOW_S = 10 * 60;

/** ステージに入るときに呼ぶ。河原・天候の種を発行して署名を付ける */
export async function POST(request: Request) {
  let stageId: unknown;
  try {
    ({ stageId } = (await request.json()) as { stageId?: unknown });
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  if (!STAGES.some((s) => s.id === stageId)) return Response.json({ error: "ステージが不正です" }, { status: 400 });
  // オンラインランキングの設定がないときは、ブラウザ側で端末保存に切り替える
  const supabase = getSupabaseAdmin();
  if (!supabase) return Response.json({ error: "オンラインランキングは無効です" }, { status: 503 });
  const issued = issuePlayToken(stageId as StageId);
  if (!issued) return Response.json({ error: "オンラインランキングは無効です" }, { status: 503 });
  const { token, claims } = issued;

  const { data: opened, error } = await supabase.rpc("open_play_session", {
    p_id: claims.sid,
    p_stage_id: claims.stage,
    p_ip_hash: clientIpHash(request),
    p_limit: SESSIONS_PER_WINDOW,
    p_window_s: SESSION_WINDOW_S,
  });
  if (error) {
    console.error("session open failed", error.message);
    return Response.json({ error: "通信に失敗しました" }, { status: 500 });
  }
  if (!opened)
    return Response.json({ error: "短い時間にステージへ入り直しすぎています。しばらく待ってからお試しください" }, { status: 429 });
  return Response.json({ token, fieldSeed: claims.fieldSeed, condSeed: claims.condSeed });
}
