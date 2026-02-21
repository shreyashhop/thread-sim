import { useState, useEffect, useRef, useCallback } from "react";

const COLOR = {
  bg: "#0a0c0f", panel: "#0f1318", border: "#1e2530",
  accent: "#00e5ff", green: "#00ff9d", yellow: "#ffd166",
  red: "#ff4d6d", purple: "#c77dff", orange: "#ff9a3c",
  muted: "#3a4555", text: "#c8d6e5", dim: "#5a6a7e",
};

const STATE_COLOR = {
  NEW: COLOR.muted, READY: COLOR.yellow, RUNNING: COLOR.green,
  BLOCKED: COLOR.red, WAITING: COLOR.purple, DEADLOCKED: COLOR.orange, TERMINATED: COLOR.dim,
};

const STATE_ORDER = ["NEW", "READY", "RUNNING", "BLOCKED", "WAITING", "DEADLOCKED", "TERMINATED"];

const MODELS = {
  "Many-to-One": {
    short: "M:1",
    desc: "All user threads map to a single kernel thread.",
    detail: "Only one user thread can run at a time — if it blocks, all threads block. Simple to implement but no true parallelism. Used in early Green Thread systems (e.g., Java pre-1.3).",
    pros: ["Low overhead", "No kernel involvement", "Simple implementation"],
    cons: ["No parallelism", "One block = all block", "Can't use multiple CPUs"],
    kernelCount: 1, userCount: 4,
  },
  "One-to-One": {
    short: "1:1",
    desc: "Each user thread maps to its own kernel thread.",
    detail: "True parallelism — each thread can run on a separate CPU core simultaneously. Blocking one thread doesn't affect others. Used in Linux, Windows, and most modern OS.",
    pros: ["True parallelism", "Independent blocking", "Multi-core utilization"],
    cons: ["High thread creation overhead", "OS limits on thread count", "More memory usage"],
    kernelCount: 4, userCount: 4,
  },
  "Many-to-Many": {
    short: "M:N",
    desc: "User threads multiplexed over a pool of kernel threads.",
    detail: "Best of both worlds — multiple user threads map to a smaller pool of kernel threads. The OS scheduler decides which kernel thread runs which user thread. Used in Solaris and Go's goroutines.",
    pros: ["Flexible scheduling", "Bounded kernel threads", "Good parallelism"],
    cons: ["Complex implementation", "Harder to debug", "Scheduler overhead"],
    kernelCount: 2, userCount: 5,
  },
};

const SYNC_INFO = {
  Semaphore: {
    desc: "A counter-based synchronization primitive. wait() decrements (blocks if 0), signal() increments (wakes a waiting thread). Binary semaphore = mutex.",
    use: "Resource counting, producer-consumer, critical sections",
  },
  Monitor: {
    desc: "A high-level synchronization construct that allows only one thread inside at a time. Uses wait() to release the lock and suspend, notify() to wake a waiting thread.",
    use: "Mutual exclusion, condition synchronization",
  },
};

let nextId = 100;
function makeThread(id, kernel = false, mappedTo = null) {
  return {
    id, label: kernel ? `KT-${id}` : `UT-${id}`,
    isKernel: kernel, state: "NEW", progress: 0,
    mappedTo, log: [], color: kernel ? COLOR.accent : COLOR.green,
    age: 0, semaphoreWait: null, deadlockHolds: null, deadlockNeeds: null,
  };
}

function makeSemaphore(name, value) {
  return { name, value, maxValue: value, queue: [] };
}

function addLog(thread, msg) {
  thread.log = [`[${new Date().toLocaleTimeString("en", { hour12: false })}] ${msg}`, ...thread.log].slice(0, 8);
}

// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [model, setModel] = useState("Many-to-One");
  const [syncTool, setSyncTool] = useState("Semaphore");
  const [running, setRunning] = useState(false);
  const [threads, setThreads] = useState([]);
  const [kernels, setKernels] = useState([]);
  const [semaphores, setSemaphores] = useState([]);
  const [monitorLock, setMonitorLock] = useState(null);
  const [monitorQueue, setMonitorQueue] = useState([]);
  const [tick, setTick] = useState(0);
  const [globalLog, setGlobalLog] = useState([]);
  const [showExplainer, setShowExplainer] = useState(false);
  const [deadlockActive, setDeadlockActive] = useState(false);
  const [deadlockDetected, setDeadlockDetected] = useState(false);
  const intervalRef = useRef(null);
  const stateRef = useRef({});

  useEffect(() => {
    stateRef.current = { threads, kernels, semaphores, monitorLock, monitorQueue, deadlockActive };
  });

  const init = useCallback((keepDeadlock = false) => {
    const cfg = MODELS[model];
    const ut = Array.from({ length: cfg.userCount }, (_, i) => makeThread(i + 1, false));
    const kt = Array.from({ length: cfg.kernelCount }, (_, i) => makeThread(i + 1, true));
    if (model === "Many-to-One") ut.forEach(t => (t.mappedTo = kt[0].id));
    else if (model === "One-to-One") ut.forEach((t, i) => (t.mappedTo = kt[i].id));
    else ut.forEach((t, i) => (t.mappedTo = kt[i % kt.length].id));
    const sems = [makeSemaphore("S1", 1), makeSemaphore("S2", 1)];
    setThreads(ut); setKernels(kt); setSemaphores(sems);
    setMonitorLock(null); setMonitorQueue([]);
    setTick(0); setGlobalLog([]);
    setRunning(false); setDeadlockDetected(false);
    if (!keepDeadlock) setDeadlockActive(false);
  }, [model]);

  useEffect(() => { init(); }, [init]);

  // ── Add thread ──────────────────────────────────────────────────────────────
  const addThread = () => {
    nextId++;
    const cfg = MODELS[model];
    const kt = stateRef.current.kernels;
    let mappedTo = null;
    if (model === "Many-to-One") mappedTo = kt[0]?.id;
    else if (model === "Many-to-Many") mappedTo = kt[nextId % kt.length]?.id;
    else {
      // One-to-One: add new kernel thread too
      const newKid = nextId;
      const newKernel = makeThread(newKid, true);
      mappedTo = newKid;
      setKernels(prev => [...prev, newKernel]);
    }
    const newT = makeThread(nextId, false, mappedTo);
    setThreads(prev => [...prev, newT]);
    setGlobalLog(g => [`+ UT-${nextId} spawned`, ...g].slice(0, 30));
  };

  // ── Kill thread ─────────────────────────────────────────────────────────────
  const killThread = (id) => {
    setThreads(prev => prev.map(t =>
      t.id === id ? { ...t, state: "TERMINATED", log: [`[killed] Forcefully terminated`, ...t.log] } : t
    ));
    setGlobalLog(g => [`✖ UT-${id} killed`, ...g].slice(0, 30));
  };

  // ── Deadlock scenario ───────────────────────────────────────────────────────
  const triggerDeadlock = () => {
    setRunning(false);
    setDeadlockActive(true);
    setDeadlockDetected(false);
    // Create 2 threads each holding one resource and waiting for the other
    const t1 = { ...makeThread(201, false), state: "BLOCKED", deadlockHolds: "R1", deadlockNeeds: "R2", mappedTo: 1 };
    const t2 = { ...makeThread(202, false), state: "BLOCKED", deadlockHolds: "R2", deadlockNeeds: "R1", mappedTo: 1 };
    addLog(t1, "Holds R1, waiting for R2");
    addLog(t2, "Holds R2, waiting for R1");
    const kt = Array.from({ length: 1 }, (_, i) => makeThread(i + 1, true));
    setThreads([t1, t2]);
    setKernels(kt);
    setSemaphores([{ name: "R1", value: 0, maxValue: 1, queue: [202] }, { name: "R2", value: 0, maxValue: 1, queue: [201] }]);
    setMonitorLock(null); setMonitorQueue([]);
    setTick(0);
    setGlobalLog(["⚠ DEADLOCK SCENARIO LOADED", "UT-201 holds R1, needs R2", "UT-202 holds R2, needs R1", "Circular wait detected!"]);
    setTimeout(() => setDeadlockDetected(true), 1200);
  };

  // ── Tick ────────────────────────────────────────────────────────────────────
  const doTick = useCallback(() => {
    if (stateRef.current.deadlockActive) return;
    setThreads(prev => {
      const next = prev.map(t => ({ ...t, log: [...t.log] }));
      const sem = stateRef.current.semaphores
        ? [...stateRef.current.semaphores.map(s => ({ ...s, queue: [...s.queue] }))]
        : [];
      let ml = stateRef.current.monitorLock;
      let mq = [...(stateRef.current.monitorQueue || [])];
      const logs = [];
      const cfg = MODELS[model];
      const maxRunning = cfg.kernelCount;

      next.forEach(t => {
        if (t.state === "TERMINATED") return;
        t.age++;
        if (t.state === "NEW" && t.age > 1) {
          t.state = "READY"; addLog(t, "Thread ready");
          logs.push(`${t.label} → READY`);
        }
        if (t.state === "READY") {
          const curRunning = next.filter(x => x.state === "RUNNING").length;
          if (curRunning < maxRunning) {
            if (syncTool === "Semaphore") {
              const targetSem = sem[t.id % sem.length];
              if (targetSem.value > 0) {
                targetSem.value--;
                t.state = "RUNNING"; t.semaphoreWait = targetSem.name;
                addLog(t, `Acquired ${targetSem.name} (val→${targetSem.value})`);
                logs.push(`${t.label} acquired ${targetSem.name}`);
              } else {
                t.state = "BLOCKED";
                if (!targetSem.queue.includes(t.id)) targetSem.queue.push(t.id);
                addLog(t, `Blocked on ${targetSem.name}`);
                logs.push(`${t.label} blocked on ${targetSem.name}`);
              }
            } else {
              if (!ml) {
                ml = t.id; t.state = "RUNNING";
                addLog(t, "Entered monitor"); logs.push(`${t.label} entered monitor`);
              } else if (ml !== t.id) {
                t.state = "WAITING";
                if (!mq.includes(t.id)) mq.push(t.id);
                addLog(t, "Waiting for monitor");
              }
            }
          }
        }
        if (t.state === "RUNNING") {
          t.progress = Math.min(100, t.progress + Math.random() * 18 + 4);
          if (t.progress >= 100) {
            t.state = "TERMINATED"; addLog(t, "Completed ✓");
            logs.push(`${t.label} TERMINATED`);
            if (syncTool === "Semaphore" && t.semaphoreWait) {
              const s = sem.find(x => x.name === t.semaphoreWait);
              if (s) {
                s.value = Math.min(s.maxValue, s.value + 1);
                if (s.queue.length > 0) {
                  const nid = s.queue.shift();
                  const nt = next.find(x => x.id === nid);
                  if (nt) { nt.state = "READY"; addLog(nt, `Unblocked from ${s.name}`); logs.push(`${nt.label} unblocked`); }
                }
              }
            }
            if (syncTool === "Monitor" && ml === t.id) {
              ml = null;
              if (mq.length > 0) {
                const nid = mq.shift();
                const nt = next.find(x => x.id === nid);
                if (nt) { nt.state = "READY"; addLog(nt, "Monitor released to me"); logs.push(`${nt.label} got monitor`); }
              }
            }
          }
        }
        if (t.state === "BLOCKED" && Math.random() < 0.12) {
          t.state = "READY"; addLog(t, "Unblocked (I/O done)");
        }
      });

      setSemaphores(sem); setMonitorLock(ml); setMonitorQueue(mq);
      if (logs.length) setGlobalLog(g => [...logs.reverse(), ...g].slice(0, 30));
      return next;
    });

    setKernels(prev => prev.map(k => ({ ...k, progress: (k.progress + 10) % 100 })));
    setTick(t => t + 1);
  }, [model, syncTool]);

  useEffect(() => {
    if (running) intervalRef.current = setInterval(doTick, 600);
    else clearInterval(intervalRef.current);
    return () => clearInterval(intervalRef.current);
  }, [running, doTick]);

  const allDone = threads.length > 0 && threads.every(t => t.state === "TERMINATED");
  useEffect(() => { if (allDone) setRunning(false); }, [allDone]);

  const stateCounts = STATE_ORDER.map(s => ({ s, count: threads.filter(t => t.state === s).length }));
  const userThreads = threads.filter(t => !t.isKernel);

  // ── Subcomponents ───────────────────────────────────────────────────────────
  const ProgressBar = ({ pct, color }) => (
    <div style={{ background: COLOR.muted, borderRadius: 3, height: 5, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.5s ease", boxShadow: `0 0 6px ${color}` }} />
    </div>
  );

  const ThreadCard = ({ t }) => (
    <div style={{
      background: COLOR.panel,
      border: `1px solid ${t.state === "RUNNING" ? STATE_COLOR[t.state] : t.state === "DEADLOCKED" ? COLOR.orange : COLOR.border}`,
      borderRadius: 8, padding: "10px 12px", minWidth: 155,
      boxShadow: t.state === "RUNNING" ? `0 0 12px ${STATE_COLOR[t.state]}44` : t.state === "DEADLOCKED" ? `0 0 14px ${COLOR.orange}55` : "none",
      transition: "all 0.3s", position: "relative", overflow: "hidden",
    }}>
      {t.state === "RUNNING" && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "2px", background: STATE_COLOR[t.state], animation: "scan 1.2s linear infinite" }} />}
      {t.state === "DEADLOCKED" && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "2px", background: COLOR.orange, animation: "pulse 0.6s infinite" }} />}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontFamily: "monospace", fontSize: 13, color: t.color, fontWeight: 700 }}>{t.label}</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: STATE_COLOR[t.state], border: `1px solid ${STATE_COLOR[t.state]}`, borderRadius: 4, padding: "1px 5px" }}>{t.state}</span>
          {t.state !== "TERMINATED" && !deadlockActive && (
            <button onClick={() => killThread(t.id)} title="Kill thread" style={{
              background: "transparent", border: `1px solid ${COLOR.red}44`, color: COLOR.red,
              borderRadius: 3, padding: "1px 5px", fontSize: 9, cursor: "pointer", lineHeight: 1,
            }}>✕</button>
          )}
        </div>
      </div>
      <ProgressBar pct={t.progress} color={STATE_COLOR[t.state]} />
      {t.deadlockHolds && (
        <div style={{ marginTop: 5, fontSize: 9 }}>
          <span style={{ color: COLOR.green }}>holds: {t.deadlockHolds}</span>
          {" | "}
          <span style={{ color: COLOR.red }}>needs: {t.deadlockNeeds}</span>
        </div>
      )}
      <div style={{ marginTop: 5, fontSize: 10, color: COLOR.dim }}>{t.log[0] || "—"}</div>
      {t.mappedTo && <div style={{ marginTop: 3, fontSize: 9, color: COLOR.accent }}>↗ KT-{t.mappedTo}</div>}
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: COLOR.bg, color: COLOR.text, fontFamily: "'JetBrains Mono', 'Fira Code', monospace", paddingBottom: 40 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Orbitron:wght@700;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0a0c0f; } ::-webkit-scrollbar-thumb { background: #1e2530; }
        @keyframes scan { 0% { transform: translateY(-2px); opacity:1 } 100% { transform: translateY(200px); opacity:0 } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
        @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0 } }
        @keyframes fadeIn { from { opacity:0; transform: translateY(6px) } to { opacity:1; transform: none } }
        @keyframes deadlock-flash { 0%,100%{box-shadow:0 0 0 0 #ff9a3c00} 50%{box-shadow:0 0 24px 4px #ff9a3c88} }
        button:hover { opacity: 0.85; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ borderBottom: `1px solid ${COLOR.border}`, background: "#0c0e12", padding: "16px 28px", display: "flex", alignItems: "center", gap: 16, position: "sticky", top: 0, zIndex: 100, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 17, color: COLOR.accent, letterSpacing: 3 }}>THREAD//SIM</div>
          <div style={{ fontSize: 9, color: COLOR.dim, marginTop: 1 }}>Real-Time Multithreading Simulator</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: COLOR.dim }}>MODEL</span>
          {Object.keys(MODELS).map(m => (
            <button key={m} onClick={() => { setModel(m); setDeadlockActive(false); }} style={{
              background: model === m ? COLOR.accent : "transparent", color: model === m ? COLOR.bg : COLOR.dim,
              border: `1px solid ${model === m ? COLOR.accent : COLOR.border}`,
              borderRadius: 5, padding: "4px 9px", fontSize: 9, cursor: "pointer", fontFamily: "monospace", fontWeight: 700, transition: "all 0.2s",
            }}>{MODELS[m].short}</button>
          ))}
          <span style={{ fontSize: 9, color: COLOR.dim, marginLeft: 6 }}>SYNC</span>
          {["Semaphore", "Monitor"].map(s => (
            <button key={s} onClick={() => setSyncTool(s)} style={{
              background: syncTool === s ? COLOR.purple : "transparent", color: syncTool === s ? "#fff" : COLOR.dim,
              border: `1px solid ${syncTool === s ? COLOR.purple : COLOR.border}`,
              borderRadius: 5, padding: "4px 9px", fontSize: 9, cursor: "pointer", fontFamily: "monospace", fontWeight: 700, transition: "all 0.2s",
            }}>{s}</button>
          ))}
          <button onClick={() => setShowExplainer(x => !x)} style={{
            background: showExplainer ? `${COLOR.yellow}22` : "transparent", color: COLOR.yellow,
            border: `1px solid ${COLOR.yellow}55`, borderRadius: 5, padding: "4px 10px",
            fontSize: 9, cursor: "pointer", fontFamily: "monospace", marginLeft: 4,
          }}>? LEARN</button>
          <button onClick={triggerDeadlock} style={{
            background: deadlockActive ? `${COLOR.orange}22` : "transparent", color: COLOR.orange,
            border: `1px solid ${COLOR.orange}55`, borderRadius: 5, padding: "4px 10px",
            fontSize: 9, cursor: "pointer", fontFamily: "monospace",
          }}>⚠ DEADLOCK</button>
          {!deadlockActive && (
            <button onClick={addThread} style={{
              background: `${COLOR.green}15`, color: COLOR.green,
              border: `1px solid ${COLOR.green}44`, borderRadius: 5, padding: "4px 10px",
              fontSize: 9, cursor: "pointer", fontFamily: "monospace",
            }}>+ THREAD</button>
          )}
          <button onClick={() => setRunning(r => !r)} disabled={deadlockActive} style={{
            background: deadlockActive ? COLOR.muted : running ? COLOR.red : COLOR.green,
            color: COLOR.bg, border: "none", borderRadius: 5, padding: "6px 14px",
            fontSize: 10, cursor: deadlockActive ? "not-allowed" : "pointer",
            fontFamily: "monospace", fontWeight: 700,
            boxShadow: deadlockActive ? "none" : `0 0 14px ${running ? COLOR.red : COLOR.green}66`,
            transition: "all 0.2s",
          }}>{running ? "⏸ PAUSE" : allDone ? "↺ REPLAY" : "▶ START"}</button>
          <button onClick={() => init()} style={{
            background: "transparent", color: COLOR.dim, border: `1px solid ${COLOR.border}`,
            borderRadius: 5, padding: "6px 10px", fontSize: 10, cursor: "pointer", fontFamily: "monospace",
          }}>RESET</button>
        </div>
      </div>

      <div style={{ padding: "20px 28px", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* ── Explainer Panel ── */}
        {showExplainer && (
          <div style={{ background: "#0c1020", border: `1px solid ${COLOR.yellow}33`, borderRadius: 10, padding: 20, animation: "fadeIn 0.3s ease" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
              {Object.entries(MODELS).map(([name, info]) => (
                <div key={name} style={{
                  background: model === name ? `${COLOR.yellow}0a` : COLOR.panel,
                  border: `1px solid ${model === name ? COLOR.yellow : COLOR.border}`,
                  borderRadius: 8, padding: 14,
                }}>
                  <div style={{ color: COLOR.yellow, fontWeight: 700, fontSize: 12, marginBottom: 4 }}>{name}</div>
                  <div style={{ color: COLOR.dim, fontSize: 10, marginBottom: 8 }}>{info.detail}</div>
                  <div style={{ fontSize: 9, marginBottom: 2, color: COLOR.green }}>✓ {info.pros.join(" · ")}</div>
                  <div style={{ fontSize: 9, color: COLOR.red }}>✗ {info.cons.join(" · ")}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {Object.entries(SYNC_INFO).map(([name, info]) => (
                <div key={name} style={{
                  background: syncTool === name ? `${COLOR.purple}0a` : COLOR.panel,
                  border: `1px solid ${syncTool === name ? COLOR.purple : COLOR.border}`,
                  borderRadius: 8, padding: 14,
                }}>
                  <div style={{ color: COLOR.purple, fontWeight: 700, fontSize: 12, marginBottom: 4 }}>{name}</div>
                  <div style={{ color: COLOR.dim, fontSize: 10, marginBottom: 6 }}>{info.desc}</div>
                  <div style={{ fontSize: 9, color: COLOR.accent }}>Use case: {info.use}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Deadlock alert ── */}
        {deadlockActive && (
          <div style={{
            background: `${COLOR.orange}11`, border: `1px solid ${COLOR.orange}`,
            borderRadius: 10, padding: "14px 20px",
            animation: deadlockDetected ? "deadlock-flash 1.5s infinite" : "fadeIn 0.3s ease",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
              <span style={{ fontSize: 22 }}>⚠</span>
              <div>
                <div style={{ color: COLOR.orange, fontWeight: 700, fontSize: 14 }}>
                  {deadlockDetected ? "🔴 DEADLOCK DETECTED" : "Loading deadlock scenario..."}
                </div>
                <div style={{ color: COLOR.dim, fontSize: 10, marginTop: 2 }}>
                  Circular wait condition: UT-201 ↔ UT-202 are waiting on each other's resources
                </div>
              </div>
              <button onClick={() => init()} style={{
                marginLeft: "auto", background: COLOR.orange, color: COLOR.bg,
                border: "none", borderRadius: 5, padding: "6px 14px",
                fontSize: 10, cursor: "pointer", fontFamily: "monospace", fontWeight: 700,
              }}>RESOLVE (Reset)</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, fontSize: 10 }}>
              {[
                { title: "Mutual Exclusion", desc: "R1 and R2 held exclusively — cannot be shared", icon: "🔒" },
                { title: "Hold & Wait", desc: "UT-201 holds R1 while waiting for R2 (and vice versa)", icon: "✋" },
                { title: "Circular Wait", desc: "UT-201 → R2 → UT-202 → R1 → UT-201 (cycle!)", icon: "🔄" },
              ].map(c => (
                <div key={c.title} style={{ background: COLOR.panel, border: `1px solid ${COLOR.border}`, borderRadius: 6, padding: 10 }}>
                  <div style={{ marginBottom: 4 }}>{c.icon} <span style={{ color: COLOR.orange }}>{c.title}</span></div>
                  <div style={{ color: COLOR.dim, fontSize: 9 }}>{c.desc}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 9, color: COLOR.dim }}>
              💡 <span style={{ color: COLOR.text }}>Solutions:</span> Resource ordering · Timeout-based detection · Banker's algorithm · Preemption
            </div>
          </div>
        )}

        {/* ── Model info bar ── */}
        <div style={{ background: `${COLOR.accent}0d`, border: `1px solid ${COLOR.accent}22`, borderRadius: 8, padding: "8px 14px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: COLOR.accent, fontSize: 14 }}>◈</span>
          <div style={{ fontSize: 11, color: COLOR.accent }}>
            <span style={{ fontWeight: 700 }}>{model}</span> — {MODELS[model].desc}
          </div>
          <div style={{ marginLeft: "auto", fontSize: 9, color: COLOR.dim }}>
            TICK #{tick.toString().padStart(4, "0")} &nbsp;|&nbsp; {syncTool}
          </div>
        </div>

        {/* ── State summary ── */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {stateCounts.filter(x => x.s !== "NEW" || x.count > 0).map(({ s, count }) => (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 5, background: COLOR.panel, border: `1px solid ${COLOR.border}`, borderRadius: 6, padding: "4px 10px" }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: STATE_COLOR[s] }} />
              <span style={{ fontSize: 9, color: STATE_COLOR[s] }}>{s}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: count > 0 ? STATE_COLOR[s] : COLOR.muted }}>{count}</span>
            </div>
          ))}
        </div>

        {/* ── Main grid ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 270px", gap: 18 }}>

          {/* User Threads */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <SectionLabel label="USER THREADS" color={COLOR.green} count={userThreads.length} />
              {!deadlockActive && (
                <button onClick={addThread} style={{
                  marginLeft: 6, background: `${COLOR.green}15`, color: COLOR.green,
                  border: `1px solid ${COLOR.green}33`, borderRadius: 4,
                  padding: "2px 8px", fontSize: 9, cursor: "pointer", fontFamily: "monospace",
                }}>+ add</button>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {userThreads.map(t => <ThreadCard key={t.id} t={t} />)}
            </div>
          </div>

          {/* Kernel Threads + Mapping */}
          <div>
            <SectionLabel label="KERNEL THREADS" color={COLOR.accent} count={kernels.length} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
              {kernels.map(k => (
                <div key={k.id} style={{ background: COLOR.panel, border: `1px solid ${COLOR.accent}33`, borderRadius: 8, padding: "10px 12px", minWidth: 155, boxShadow: `0 0 8px ${COLOR.accent}11` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ color: COLOR.accent, fontWeight: 700, fontSize: 13 }}>{k.label}</span>
                    <span style={{ fontSize: 9, color: COLOR.accent, border: `1px solid ${COLOR.accent}44`, borderRadius: 4, padding: "1px 5px" }}>ACTIVE</span>
                  </div>
                  <div style={{ background: COLOR.muted, borderRadius: 3, height: 5, overflow: "hidden" }}>
                    <div style={{ width: `${k.progress}%`, height: "100%", background: COLOR.accent, borderRadius: 3, boxShadow: `0 0 6px ${COLOR.accent}`, transition: "width 0.5s" }} />
                  </div>
                  <div style={{ marginTop: 5, fontSize: 9, color: COLOR.dim }}>
                    Mapped: {userThreads.filter(t => t.mappedTo === k.id).map(t => t.label).join(", ") || "—"}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 14 }}>
              <SectionLabel label="MAPPING DIAGRAM" color={COLOR.yellow} />
              <div style={{ background: COLOR.panel, border: `1px solid ${COLOR.border}`, borderRadius: 8, padding: 12, marginTop: 8, fontSize: 11 }}>
                {userThreads.map(t => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, opacity: t.state === "TERMINATED" ? 0.3 : 1, animation: "fadeIn 0.3s ease" }}>
                    <span style={{ color: COLOR.green, minWidth: 52 }}>{t.label}</span>
                    <div style={{ flex: 1, height: 1, background: `${STATE_COLOR[t.state]}55`, position: "relative" }}>
                      <div style={{ position: "absolute", top: -3, left: "50%", width: 6, height: 6, borderRadius: "50%", background: STATE_COLOR[t.state], animation: t.state === "RUNNING" ? "pulse 0.8s infinite" : "none" }} />
                    </div>
                    <span style={{ color: COLOR.accent, minWidth: 52 }}>{t.mappedTo ? `KT-${t.mappedTo}` : "—"}</span>
                    <span style={{ fontSize: 9, color: STATE_COLOR[t.state], minWidth: 70 }}>{t.state}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: Sync + Log */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <SectionLabel label={syncTool.toUpperCase()} color={COLOR.purple} />
              <div style={{ background: COLOR.panel, border: `1px solid ${COLOR.purple}33`, borderRadius: 8, padding: 12, marginTop: 8 }}>
                {syncTool === "Semaphore" ? (
                  <>
                    {semaphores.map(s => (
                      <div key={s.name} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                          <span style={{ color: COLOR.purple }}>{s.name}</span>
                          <span style={{ color: s.value > 0 ? COLOR.green : COLOR.red }}>{s.value}/{s.maxValue}</span>
                        </div>
                        <div style={{ background: COLOR.muted, borderRadius: 3, height: 6, overflow: "hidden" }}>
                          <div style={{ width: `${(s.value / s.maxValue) * 100}%`, height: "100%", background: s.value > 0 ? COLOR.purple : COLOR.red, transition: "width 0.3s", borderRadius: 3 }} />
                        </div>
                        {s.queue.length > 0 && <div style={{ fontSize: 9, color: COLOR.red, marginTop: 2 }}>Waiting: {s.queue.map(id => `UT-${id}`).join(", ")}</div>}
                      </div>
                    ))}
                    <div style={{ fontSize: 9, color: COLOR.dim, borderTop: `1px solid ${COLOR.border}`, paddingTop: 6 }}>wait() ↓ val · signal() ↑ val</div>
                  </>
                ) : (
                  <>
                    <div style={{ padding: "8px 10px", borderRadius: 6, background: monitorLock ? `${COLOR.green}11` : `${COLOR.red}11`, border: `1px solid ${monitorLock ? COLOR.green : COLOR.red}22`, marginBottom: 8 }}>
                      <div style={{ fontSize: 9, color: COLOR.dim, marginBottom: 2 }}>LOCK HOLDER</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: monitorLock ? COLOR.green : COLOR.red }}>{monitorLock ? `UT-${monitorLock}` : "UNLOCKED"}</div>
                    </div>
                    <div style={{ fontSize: 9, color: COLOR.dim, marginBottom: 4 }}>WAIT QUEUE</div>
                    {monitorQueue.length === 0
                      ? <div style={{ fontSize: 9, color: COLOR.muted }}>empty</div>
                      : monitorQueue.map(id => <div key={id} style={{ fontSize: 9, color: COLOR.purple, padding: "2px 6px", background: `${COLOR.purple}11`, borderRadius: 4, marginBottom: 2 }}>UT-{id} waiting…</div>)
                    }
                    <div style={{ fontSize: 9, color: COLOR.dim, borderTop: `1px solid ${COLOR.border}`, marginTop: 8, paddingTop: 6 }}>One thread inside at a time</div>
                  </>
                )}
              </div>
            </div>

            <div style={{ flex: 1 }}>
              <SectionLabel label="EVENT LOG" color={COLOR.yellow} />
              <div style={{ background: COLOR.panel, border: `1px solid ${COLOR.border}`, borderRadius: 8, padding: 10, marginTop: 8, maxHeight: 240, overflowY: "auto" }}>
                {globalLog.length === 0
                  ? <div style={{ color: COLOR.muted, fontSize: 10 }}><span style={{ animation: "blink 1s infinite", display: "inline-block" }}>▌</span> Awaiting events...</div>
                  : globalLog.map((l, i) => (
                    <div key={i} style={{ fontSize: 9, color: i === 0 ? COLOR.text : COLOR.dim, padding: "2px 0", borderBottom: `1px solid ${COLOR.border}`, animation: i === 0 ? "fadeIn 0.3s ease" : "none" }}>{l}</div>
                  ))
                }
              </div>
            </div>
          </div>
        </div>

        {/* ── Thread logs ── */}
        <div>
          <SectionLabel label="THREAD ACTIVITY LOGS" color={COLOR.dim} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8, marginTop: 10 }}>
            {userThreads.map(t => (
              <div key={t.id} style={{ background: COLOR.panel, border: `1px solid ${COLOR.border}`, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.color, marginBottom: 5 }}>{t.label}</div>
                {t.log.slice(0, 4).map((l, i) => <div key={i} style={{ fontSize: 9, color: i === 0 ? COLOR.text : COLOR.dim, marginBottom: 2 }}>{l}</div>)}
                {t.log.length === 0 && <div style={{ fontSize: 9, color: COLOR.muted }}>no activity yet</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ label, color, count }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 3, height: 13, background: color, borderRadius: 2 }} />
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color }}>{label}</span>
      {count !== undefined && <span style={{ fontSize: 9, color: "#5a6a7e", marginLeft: 2 }}>×{count}</span>}
    </div>
  );
}
