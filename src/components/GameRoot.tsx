"use client";

import { Check, Flame } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { driftConditions, rollConditions } from "@/game/conditions";
import { simulateThrow, throwDirection } from "@/game/physics";
import { currentAt, getStage, MOVE_RANGE, riverCenterZ, STAGES } from "@/game/stages";
import { ADD_SERIAL_BASE, canAddStones, spawnStones } from "@/game/stones";
import type { Conditions, StageId, StoneSpec, ThrowResult } from "@/game/types";
import { randomSeed } from "@/game/rng";
import { conditionsAt, driftSeed, type ThrowSubmission } from "@/game/verify";
import { fetchThrowSeed, startPlay, type PlaySession } from "@/lib/scores";
import type { GameScene as GameSceneType } from "@/three/GameScene";
import AimPanel, { ELEVATION_MAX } from "./AimPanel";
import HelpDialog from "./HelpDialog";
import PositionPanel, { YAW_LIMIT } from "./PositionPanel";
import PowerGauge from "./PowerGauge";
import ResultDialog from "./ResultDialog";
import StagePanelSelect from "./StageSelect";
import StonePanel from "./StonePanel";
import TopBar from "./TopBar";

type Phase = "title" | "loading" | "select" | "position" | "aim" | "power" | "flight" | "result";

const BEST_KEY = "skipping-stones:best";
const MUTED_KEY = "skipping-stones:muted";
const DEFAULT_ELEVATION = 10;

function readBest(): Partial<Record<StageId, number>> {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? "{}") as Partial<Record<StageId, number>>;
  } catch {
    return {};
  }
}

export default function GameRoot() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GameSceneType | null>(null);
  const loadedStageRef = useRef<StageId | null>(null);
  const appliedCondRef = useRef<Conditions | null>(null);

  const [booting, setBooting] = useState(true);
  const [phase, setPhase] = useState<Phase>("title");
  const [stageId, setStageId] = useState<StageId>("mountain-stream");
  const stage = getStage(stageId);
  const [cond, setCond] = useState<Conditions | null>(null);
  const [stones, setStones] = useState<StoneSpec[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [throwX, setThrowX] = useState(0);
  const [yaw, setYaw] = useState(0);
  const [elevation, setElevation] = useState(DEFAULT_ELEVATION);
  const [bounces, setBounces] = useState(0);
  const [result, setResult] = useState<ThrowResult | null>(null);
  const [best, setBest] = useState<Partial<Record<StageId, number>>>({});
  const [sessionBest, setSessionBest] = useState(0);
  const [isNewBest, setIsNewBest] = useState(false);
  const [help, setHelp] = useState(false);
  // 最初に保存済みの設定を読む（後から読むと、保存の処理に上書きされてしまう）
  const [muted, setMuted] = useState(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem(MUTED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [toast, setToast] = useState<string | null>(null);

  const onFlightEndRef = useRef<() => void>(() => {});
  // 今のプレイの種（オンラインならサーバーの署名付き）と、何投目・何個追加したか
  const playRef = useRef<(PlaySession & { throwIndex: number; addedCount: number }) | null>(null);
  const lastThrowRef = useRef<ThrowSubmission | null>(null);
  /** 今の投擲の乱数をサーバーが決めたか（決めていない投擲はオンラインに記録しない） */
  const serverLuckRef = useRef(false);

  // ---------- 3D シーンの生成 ----------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let scene: GameSceneType | null = null;
    setBest(readBest());
    // three.js はブラウザでだけ読み込む
    import("@/three/GameScene").then(({ GameScene }) => {
      if (disposed) return;
      scene = new GameScene(el, {
        onHoverStone: (id) => setHoveredId(id),
        onPickStone: (id) => setSelectedId(id),
        onBounce: (n) => setBounces(n),
        onFlightEnd: () => onFlightEndRef.current(),
        onSwipe: (dx) => setThrowX((x) => Math.max(-MOVE_RANGE, Math.min(MOVE_RANGE, x + dx))),
      });
      sceneRef.current = scene;
      // タイトル画面の背景
      window.setTimeout(() => {
        if (disposed || !scene) return;
        const st = STAGES[0];
        const c = rollConditions(st);
        scene.setStage(st, c);
        scene.setMode("overview");
        loadedStageRef.current = st.id;
        appliedCondRef.current = c;
        setCond(c);
        setBooting(false);
      }, 30);
    });
    return () => {
      disposed = true;
      scene?.dispose();
      sceneRef.current = null;
    };
  }, []);

  // ---------- シーンとの同期 ----------
  useEffect(() => {
    sceneRef.current?.setStones(stones);
  }, [stones, booting]);

  // 音を消す設定は端末に覚えておく
  useEffect(() => {
    sceneRef.current?.setMuted(muted);
    try {
      localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
    } catch {
      // 保存できなくても続行
    }
  }, [muted, booting]);

  useEffect(() => {
    sceneRef.current?.setSelectedStone(selectedId);
  }, [selectedId]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    if (phase === "title" || phase === "loading") s.setMode("overview");
    else if (phase === "select" || phase === "position" || phase === "aim" || phase === "power") s.setMode(phase);
  }, [phase]);

  useEffect(() => {
    sceneRef.current?.setThrow(throwX, yaw, elevation);
  }, [throwX, yaw, elevation]);

  useEffect(() => {
    if (cond && sceneRef.current && cond !== appliedCondRef.current) {
      appliedCondRef.current = cond;
      sceneRef.current.setConditions(cond);
    }
  }, [cond]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ---------- 進行 ----------
  const enterStage = useCallback((id: StageId) => {
    setPhase("loading");
    startPlay(id).then((play) => window.setTimeout(() => {
      playRef.current = { ...play, throwIndex: 0, addedCount: 0 };
      const scene = sceneRef.current;
      const st = getStage(id);
      const c = conditionsAt(st, play.condSeed, 0);
      if (scene) {
        if (loadedStageRef.current !== id) {
          setStones([]);
          scene.setStones([]);
          scene.setStage(st, c);
          loadedStageRef.current = id;
        } else {
          scene.setConditions(c);
        }
      }
      appliedCondRef.current = c;
      setCond(c);
      setStageId(id);
      setStones(spawnStones(st, st.initialStones, [], play.fieldSeed));
      setSelectedId(null);
      setHoveredId(null);
      setThrowX(0);
      setYaw(0);
      setElevation(DEFAULT_ELEVATION);
      setSessionBest(0);
      if (play.notice) setToast(play.notice);
      setPhase("select");
    }, 60));
  }, []);

  const backToTitle = useCallback(() => {
    setSelectedId(null);
    setResult(null);
    setPhase("title");
  }, []);

  const addStones = useCallback(() => {
    const play = playRef.current;
    if (!play || !canAddStones(stage, stones.length)) return;
    // 今いる場所の周りに追加する（石の通し番号は追加した順に続ける。サーバーはこの範囲を超える番号を受け付けない）
    const added = spawnStones(stage, stage.addBatch, stones, play.fieldSeed, throwX, ADD_SERIAL_BASE + play.addedCount);
    play.addedCount += added.length;
    if (added.length === 0) {
      setToast("河原に石を置く場所がありません");
      return;
    }
    setStones([...stones, ...added]);
    setToast(`石を${added.length}個見つけました`);
  }, [stage, stones, throwX]);

  const selected = useMemo(() => stones.find((s) => s.id === selectedId) ?? null, [stones, selectedId]);
  const hovered = useMemo(() => stones.find((s) => s.id === hoveredId) ?? null, [stones, hoveredId]);

  const confirmStone = useCallback(() => {
    if (!selected) return;
    setThrowX(Math.round(selected.x));
    setPhase("position");
  }, [selected]);

  const onGaugeComplete = useCallback(
    async (values: number[]) => {
      const play = playRef.current;
      if (!selected || !cond || !play) return;
      const power = values.reduce((a, b) => a + b, 0);
      const submission: ThrowSubmission = {
        stoneSerial: selected.serial,
        throwIndex: play.throwIndex,
        originX: throwX,
        elevationDeg: elevation,
        yawDeg: yaw,
        gauge: values,
      };
      lastThrowRef.current = submission;
      // 投擲の乱数（石の当たり外れ・炎・ブレ）は、オンラインでは投げた瞬間にサーバーが決める（ブラウザでは前もって計算できない）
      const luck = play.token ? await fetchThrowSeed(play.token, submission) : null;
      const serverSeed = luck && "seed" in luck ? luck.seed : null;
      serverLuckRef.current = serverSeed !== null;
      if (luck && "error" in luck) setToast(luck.error);
      const res = simulateThrow({
        stone: selected,
        conditions: cond,
        stage,
        originX: throwX,
        elevationDeg: elevation,
        yawDeg: yaw,
        power,
        seed: serverSeed ?? randomSeed(),
      });
      setResult(res);
      setBounces(0);
      setPhase("flight");
      sceneRef.current?.startFlight(res);
    },
    [selected, cond, stage, throwX, elevation, yaw],
  );

  // 開発時の動作確認用
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __throw?: (v: number[]) => void }).__throw = onGaugeComplete;
  }, [onGaugeComplete]);

  onFlightEndRef.current = () => {
    if (!result) return;
    const n = result.bounces.length;
    const prev = best[stageId];
    const newBest = prev === undefined || n > prev;
    setIsNewBest(newBest);
    if (newBest) {
      const next = { ...best, [stageId]: n };
      setBest(next);
      try {
        localStorage.setItem(BEST_KEY, JSON.stringify(next));
      } catch {
        // 保存できなくても続行
      }
    }
    setSessionBest((b) => Math.max(b, n));
    setPhase("result");
  };

  const finishThrow = useCallback(() => {
    setStones((list) => list.filter((s) => s.id !== selectedId));
    setSelectedId(null);
    setResult(null);
    const play = playRef.current;
    if (cond && play) {
      setCond(driftConditions(stage, cond, driftSeed(play.condSeed, play.throwIndex)));
      play.throwIndex += 1;
    }
  }, [selectedId, cond, stage]);

  const retry = useCallback(() => {
    finishThrow();
    setPhase("select");
  }, [finishThrow]);

  const changeStage = useCallback(() => {
    finishThrow();
    setPhase("title");
  }, [finishThrow]);

  // ---------- キーボード操作 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (help || (e.target as HTMLElement)?.tagName === "INPUT" && (e.target as HTMLInputElement).type === "text") return;
      if (phase === "position") {
        if (e.key === "ArrowLeft") setThrowX((x) => Math.max(-MOVE_RANGE, x - 1));
        else if (e.key === "ArrowRight") setThrowX((x) => Math.min(MOVE_RANGE, x + 1));
        else if (e.key === "a" || e.key === "A") setYaw((y) => Math.max(-YAW_LIMIT, y - 2));
        else if (e.key === "d" || e.key === "D") setYaw((y) => Math.min(YAW_LIMIT, y + 2));
        else if (e.key === "Enter") setPhase("aim");
        else if (e.key === "Escape") setPhase("select");
        else return;
        e.preventDefault();
      } else if (phase === "aim") {
        if (e.key === "ArrowUp" || e.key === "ArrowRight") setElevation((v) => Math.min(ELEVATION_MAX, v + 1));
        else if (e.key === "ArrowDown" || e.key === "ArrowLeft") setElevation((v) => Math.max(0, v - 1));
        else if (e.key === "Enter") setPhase("power");
        else if (e.key === "Escape") setPhase("position");
        else return;
        e.preventDefault();
      } else if (phase === "select") {
        if (e.key === "Enter" && selected) confirmStone();
        else if (e.key === "Escape") setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, help, selected, confirmStone]);

  // 石を探すときは自分で河原を歩く（押している間だけ進む。Shift で走る）
  const walkButtonRef = useRef(0);
  useEffect(() => {
    if (phase !== "select" || help) return;
    const held = new Set<string>();
    const keys = ["arrowleft", "arrowright", "a", "d", "shift"];
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!keys.includes(k)) return;
      held.add(k);
      if (k !== "shift") e.preventDefault();
    };
    const up = (e: KeyboardEvent) => held.delete(e.key.toLowerCase());
    const clear = () => held.clear();
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const dir =
        (held.has("arrowright") || held.has("d") ? 1 : 0) - (held.has("arrowleft") || held.has("a") ? 1 : 0) + walkButtonRef.current;
      if (dir !== 0) {
        const speed = held.has("shift") ? 4 : 1.8;
        setThrowX((x) => Math.max(-MOVE_RANGE, Math.min(MOVE_RANGE, x + Math.sign(dir) * speed * dt)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      walkButtonRef.current = 0;
    };
  }, [phase, help]);

  const throwAngle = useMemo(() => {
    const d = throwDirection(yaw);
    return Math.atan2(d.z, d.x);
  }, [yaw]);
  const localCurrent = cond ? currentAt(stage, cond, throwX, riverCenterZ(stage, throwX)) : 0;
  const inGame = phase !== "title" && phase !== "loading";

  return (
    <main className="game-root">
      <div ref={containerRef} className="scene" aria-label="川の3D風景" />

      {inGame && cond && (
        <div className="overlay">
          <TopBar
            stage={stage}
            conditions={cond}
            throwAngle={throwAngle}
            localCurrent={localCurrent}
            stoneCount={stones.length}
            onBack={backToTitle}
            onHelp={() => setHelp(true)}
            muted={muted}
            onToggleMute={() => setMuted((m) => !m)}
          />

          {phase === "flight" && (
            <div className="flight-hud surface" aria-live="polite">
              <span key={bounces} className={`flight-hud__count ${bounces > 0 ? "bump" : ""}`}>
                {bounces}
              </span>
              <span className="label-l muted">回 跳ねた</span>
              {result?.fire && (
                <span className="flight-hud__fire label-l">
                  <Flame size={16} /> 炎の水切り！回数2倍
                </span>
              )}
            </div>
          )}

          <div className="dock">
            {phase === "select" && (
              <StonePanel
                stage={stage}
                stones={stones}
                shown={hovered ?? selected}
                selected={selected}
                x={throwX}
                onWalk={(dir) => (walkButtonRef.current = dir)}
                canAdd={canAddStones(stage, stones.length)}
                onAdd={addStones}
                onConfirm={confirmStone}
                onZoomOut={() => setSelectedId(null)}
              />
            )}
            {phase === "position" && (
              <PositionPanel
                x={throwX}
                yaw={yaw}
                localCurrent={localCurrent}
                onMove={setThrowX}
                onYaw={setYaw}
                onBack={() => setPhase("select")}
                onConfirm={() => setPhase("aim")}
              />
            )}
            {phase === "aim" && (
              <AimPanel elevation={elevation} onChange={setElevation} onBack={() => setPhase("position")} onConfirm={() => setPhase("power")} />
            )}
            {phase === "power" && <PowerGauge onComplete={onGaugeComplete} onBack={() => setPhase("aim")} />}
          </div>
        </div>
      )}

      {phase === "result" && result && cond && lastThrowRef.current && (
        <ResultDialog
          stage={stage}
          bounces={result.bounces.length}
          distance={result.distance}
          endReason={result.endReason}
          weather={cond.weather}
          isNewBest={isNewBest}
          sessionBest={sessionBest}
          onRetry={retry}
          onChangeStage={changeStage}
          fire={result.fire}
          token={serverLuckRef.current ? (playRef.current?.token ?? null) : null}
          submission={lastThrowRef.current}
        />
      )}

      {phase === "title" && !booting && <StagePanelSelect best={best} onSelect={enterStage} />}

      {(phase === "loading" || booting) && (
        <div className="loading" role="status">
          <div className="loading__box">
            <div className="spinner" />
            <span className="body-l">川辺へ向かっています…</span>
          </div>
        </div>
      )}

      {help && <HelpDialog onClose={() => setHelp(false)} />}

      {toast && (
        <div className="toast body-m" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
    </main>
  );
}
