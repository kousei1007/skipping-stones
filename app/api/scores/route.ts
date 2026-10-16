import { getStage } from "@/game/stages";
import { entersTopRanking, HIDDEN_SCORE_IDS, isRankingClosed, RANKING_SINCE, RANKING_SIZE, type ThrowSubmission } from "@/game/verify";
import { verifyPlayToken } from "@/lib/playToken";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

/**
 * 記録を受け付ける。ブラウザからは「何投目か」だけを使い、
 * 跳ねた回数は投げた瞬間に /api/stone-luck が計算して保存したものを使う（送られてきた回数や投げ方は使わない）。
 */
export async function POST(request: Request) {
  let body: { token?: unknown; playerName?: unknown; throw?: ThrowSubmission };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const claims = verifyPlayToken(body.token);
  if (!claims) return Response.json({ error: "プレイの情報が無効か、期限が切れています" }, { status: 401 });

  // 締め切り後は受け付けない（サーバーの時計で判定するので、ブラウザ側の時刻は関係ない）
  if (isRankingClosed()) return Response.json({ error: "ランキングの受付は終了しました" }, { status: 403 });

  const name = typeof body.playerName === "string" ? body.playerName.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  if (name.length < 1 || name.length > 20) return Response.json({ error: "名前は1〜20文字で入力してください" }, { status: 400 });

  const stage = getStage(claims.stage);
  const throwIndex = body.throw?.throwIndex;
  if (!Number.isInteger(throwIndex) || (throwIndex as number) < 0) return Response.json({ error: "投擲番号が不正です" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  if (!supabase) return Response.json({ error: "オンラインランキングは無効です" }, { status: 503 });

  const { data: reveal, error: revealError } = await supabase
    .from("throw_reveals")
    .select("stone_serial, bounces, distance, weather")
    .eq("session_id", claims.sid)
    .eq("throw_index", throwIndex)
    .maybeSingle();
  if (revealError) {
    console.error("throw reveal fetch failed", revealError.message);
    return Response.json({ error: "記録に失敗しました" }, { status: 500 });
  }
  if (!reveal || reveal.bounces === null) return Response.json({ error: "この投擲は記録できません" }, { status: 404 });
  const { bounces, distance, weather } = reveal as { bounces: number; distance: number; weather: string };

  // 上位に入らない記録は保存しない（画面で隠すだけでなく、サーバーでも確かめる）
  const { data: top, error: topError } = await supabase
    .from("scores")
    .select("bounces, distance")
    .eq("stage_id", stage.id)
    .gte("created_at", RANKING_SINCE)
    .not("id", "in", `(${HIDDEN_SCORE_IDS.join(",")})`)
    .order("bounces", { ascending: false })
    .order("distance", { ascending: false })
    .limit(RANKING_SIZE);
  if (topError) {
    console.error("ranking fetch failed", topError.message);
    return Response.json({ error: "記録に失敗しました" }, { status: 500 });
  }
  if (!entersTopRanking(top ?? [], bounces, distance))
    return Response.json({ error: `${RANKING_SIZE}位以内に入らなかったため記録できません` }, { status: 409 });

  // 同じプレイの中では名前を変えられない（最初に記録した名前に固定）
  const { data: prev, error: prevError } = await supabase.from("scores").select("player_name").eq("session_id", claims.sid).limit(1);
  if (prevError) {
    console.error("name check failed", prevError.message);
    return Response.json({ error: "記録に失敗しました" }, { status: 500 });
  }
  if (prev?.[0] && prev[0].player_name !== name)
    return Response.json({ error: `名前は変更できません（「${prev[0].player_name}」で記録してください）` }, { status: 409 });

  const { error } = await supabase.from("scores").insert({
    player_name: name,
    stage_id: stage.id,
    bounces,
    distance: Math.round(distance * 10) / 10,
    weather,
    session_id: claims.sid,
    throw_index: throwIndex,
    stone_serial: reveal.stone_serial,
  });
  if (error) {
    // 同じ投擲・同じ石の二重登録はデータベースの一意制約で弾く
    if (error.code === "23505") return Response.json({ error: "この投擲はすでに記録されています" }, { status: 409 });
    console.error("score insert failed", error.message);
    return Response.json({ error: "記録に失敗しました" }, { status: 500 });
  }
  return Response.json({ bounces, distance });
}
