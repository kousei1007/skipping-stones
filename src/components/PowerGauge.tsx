"use client";

import { Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { GAUGE_ROUNDS, MAX_GAUGE_PER_ROUND } from "@/game/physics";
import { SheetHeader } from "./ui";

interface Props {
  onComplete: (values: number[]) => void;
  onBack: () => void;
}

/** 1往復（0→最大→0）にかかる秒数。回を追うごとに速くなる */
const PERIODS = [1.0, 0.82, 0.68];

/** 三角波で 0〜MAX を往復する */
const triangle = (t: number, period: number) => {
  const p = (t / period) % 1;
  return (p < 0.5 ? p * 2 : 2 - p * 2) * MAX_GAUGE_PER_ROUND;
};

export default function PowerGauge({ onComplete, onBack }: Props) {
  const [round, setRound] = useState(0);
  const [values, setValues] = useState<number[]>([]);
  const [stopped, setStopped] = useState(false);
  const fillRef = useRef<HTMLDivElement>(null);
  const gaugeRef = useRef<HTMLDivElement>(null);
  const startRef = useRef(0);
  const periodRef = useRef(PERIODS[0]);
  const stoppedRef = useRef(false);
  const valuesRef = useRef<number[]>([]);

  useEffect(() => {
    if (stopped) return;
    let raf = 0;
    startRef.current = performance.now();
    const period = PERIODS[Math.min(round, PERIODS.length - 1)];
    periodRef.current = period;
    const tick = (now: number) => {
      if (stoppedRef.current) return;
      const v = triangle((now - startRef.current) / 1000, period);
      if (fillRef.current) fillRef.current.style.width = `${(v / MAX_GAUGE_PER_ROUND) * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [round, stopped]);

  useEffect(() => {
    const el = gaugeRef.current;
    if (el && fillRef.current) fillRef.current.style.setProperty("--gauge-w", `${el.clientWidth}px`);
  }, []);

  /** 押した瞬間（イベントの時刻）の値で止め、表示もその場で固定する */
  const stop = useCallback((at: number = performance.now()) => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    const v = Math.round(triangle((at - startRef.current) / 1000, periodRef.current));
    if (fillRef.current) fillRef.current.style.width = `${(v / MAX_GAUGE_PER_ROUND) * 100}%`;
    setStopped(true);
    const next = [...valuesRef.current, v];
    valuesRef.current = next;
    setValues(next);
    window.setTimeout(() => {
      if (next.length >= GAUGE_ROUNDS) {
        onComplete(next);
        return;
      }
      stoppedRef.current = false;
      setStopped(false);
      setRound(next.length);
    }, next.length >= GAUGE_ROUNDS ? 550 : 450);
  }, [onComplete]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 「角度を変える」などほかのボタンにフォーカスがあるときは、そのボタンの操作（Space / Enter）を奪わない
      const target = e.target instanceof Element ? e.target.closest("button") : null;
      if (target && !target.hasAttribute("data-gauge-stop")) return;
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        if (!e.repeat) stop(e.timeStamp);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop]);

  return (
    <section className="sheet surface" aria-label="投げる力">
      <SheetHeader icon={<Zap size={22} />} title="力を溜める" step="4 / 4">
        ゲージをタイミングよく止める。3回の合計が投げる力になります
      </SheetHeader>
      <div className="gauge-wrap">
        <div ref={gaugeRef} className={`gauge ${stopped ? "gauge--stopped" : ""}`} aria-hidden onPointerDown={(e) => stop(e.timeStamp)}>
          <div ref={fillRef} className="gauge__fill" />
          <div className="gauge__ticks" />
        </div>
        <div className="gauge-slots" aria-label="ここまでの記録">
          {Array.from({ length: GAUGE_ROUNDS }, (_, i) => (
            <div key={i} className={`gauge-slot ${i === values.length && !stopped ? "gauge-slot--active" : ""}`}>
              <span className="label-m muted">{i + 1}回目</span>
              <div className="gauge-slot__bar">
                <span style={{ width: `${((values[i] ?? 0) / MAX_GAUGE_PER_ROUND) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        <button className="btn btn--filled stop-btn" data-gauge-stop onPointerDown={(e) => stop(e.timeStamp)} disabled={stopped}>
          {values.length < GAUGE_ROUNDS ? `ストップ（${values.length + 1}/${GAUGE_ROUNDS}）` : "投げる！"}
        </button>
        <span className="body-s muted">
          <kbd>Space</kbd> キーでも止められます
        </span>
      </div>
      <div className="sheet__actions">
        <button className="btn btn--text grow" onClick={onBack} disabled={values.length > 0}>
          角度を変える
        </button>
      </div>
    </section>
  );
}
