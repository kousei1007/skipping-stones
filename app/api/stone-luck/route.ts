import { getStage } from "@/game/stages";
import { validateSubmission, type ThrowSubmission } from "@/game/verify";
import { secretThrowSeed, verifyPlayToken } from "@/lib/playToken";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

/**
 * 投げた瞬間に呼ぶ。投擲の乱数の種（石の見えない当たり外れ・炎・ブレ）を返す。
 * 同じプレイの同じ投擲（何投目）には 1 回しか答えないので、いろいろな石で試してから選ぶことはできない。
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

  const sub = body.throw;
  const invalid = sub ? validateSubmission(getStage(claims.stage), sub) : "投擲の情報がありません";
  if (invalid || !sub) return Response.json({ error: invalid }, { status: 400 });

  const supabase = getSupabaseAdmin();
  if (!supabase) return Response.json({ error: "オンラインランキングは無効です" }, { status: 503 });

  // 種を記録しておき、/api/scores は「ここで答えた投げ方」と同じ投げ方の記録だけを受け付ける
  const seed = secretThrowSeed(claims, sub);
  const { error } = await supabase.from("throw_reveals").insert({ session_id: claims.sid, throw_index: sub.throwIndex, seed });
  if (error) {
    if (error.code === "23505") return Response.json({ error: "この投擲はすでに投げられています" }, { status: 409 });
    console.error("throw reveal insert failed", error.message);
    return Response.json({ error: "通信に失敗しました" }, { status: 500 });
  }
  return Response.json({ seed });
}
