import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { STAGES } from "@/game/stages";
import type { StageId } from "@/game/types";
import type { PlaySeeds, ThrowSubmission } from "@/game/verify";

/**
 * サーバー専用。プレイの種に署名し、記録の送信時に改ざんされていないか確かめる。
 * 署名の鍵は SCORE_SIGNING_SECRET（NEXT_PUBLIC_ を付けないのでブラウザには渡らない）。
 */
export interface PlayClaims extends PlaySeeds {
  sid: string;
  stage: StageId;
  iat: number;
}

/** 発行から何時間までの記録を受け付けるか */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function secret(): string | null {
  const s = process.env.SCORE_SIGNING_SECRET;
  return s && s.length >= 32 ? s : null;
}

const sign = (payload: string, key: string) => createHmac("sha256", key).update(payload).digest("base64url");

export function issuePlayToken(stage: StageId): { token: string; claims: PlayClaims } | null {
  const key = secret();
  if (!key) return null;
  const claims: PlayClaims = {
    sid: randomUUID(),
    stage,
    fieldSeed: randomInt(0, 0xffffffff),
    condSeed: randomInt(0, 0xffffffff),
    iat: Date.now(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${payload}.${sign(payload, key)}`, claims };
}

/**
 * 投擲の乱数の種（石の見えない当たり外れ・炎・投げのブレ・水面の乱れをすべてここから決める）。
 * 鍵を知らないと計算できず、石・何投目・投げ方が 1 つでも違えば別の値になる。
 * そのため河原や天候の種がわかっても、どの石・どの投擲で何回跳ねるかを前もって計算することはできない。
 */
export function secretThrowSeed(claims: PlayClaims, s: ThrowSubmission): number {
  const data = JSON.stringify([claims.sid, s.stoneSerial, s.throwIndex, s.originX, s.elevationDeg, s.yawDeg, s.gauge]);
  return createHmac("sha256", secret() ?? "").update(`throw:${data}`).digest().readUInt32BE(0);
}

/** IPv6 は 1 つの契約に /56 以上がまるごと割り当てられることが多い（国内の固定回線など）ので、上位 56 ビットでまとめる */
export function ipBucket(ip: string): string {
  const v4 = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  const prefix = groups.slice(0, 4).map((g) => parseInt(g || "0", 16));
  prefix[3] &= 0xff00;
  return `${prefix.map((g) => g.toString(16)).join(":")}::/56`;
}

/**
 * 回数制限に使う接続元の識別子。IP アドレスそのものは保存せず、鍵付きのハッシュにする。
 * Vercel は x-real-ip・x-forwarded-for を上書きするので、ブラウザから偽の値を送っても効かない
 */
export function clientIpHash(request: Request): string {
  const h = request.headers;
  const ip = (h.get("x-real-ip") ?? h.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  return createHmac("sha256", secret() ?? "").update(`ip:${ipBucket(ip)}`).digest("base64url").slice(0, 22);
}

export function verifyPlayToken(token: unknown): PlayClaims | null {
  const key = secret();
  if (!key || typeof token !== "string" || token.length > 1000) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString()) as PlayClaims;
    if (!STAGES.some((s) => s.id === c.stage)) return null;
    if (Date.now() - c.iat > MAX_AGE_MS) return null;
    return c;
  } catch {
    return null;
  }
}
