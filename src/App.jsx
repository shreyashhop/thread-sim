import { useState, useEffect, useRef, useCallback } from "react";

// ── Palette & helpers ──────────────────────────────────────────────────────────
const COLOR = {
  bg: "#0a0c0f",
  panel: "#0f1318",
  border: "#1e2530",
  accent: "#00e5ff",
  green: "#00ff9d",
  yellow: "#ffd166",
  red: "#ff4d6d",
  purple: "#c77dff",
  muted: "#3a4555",
  text: "#c8d6e5",
  dim: "#5a6a7e",
};

const STATE_COLOR = {
  NEW: COLOR.muted,
  READY: COLOR.yellow,
  RUNNING: COLOR.green,
  BLOCKED: COLOR.red,
  WAITING: COLOR.purple,
  TERMINATED: COLOR.dim,
};

const STATE_ORDER = ["NEW", "READY", "RUNNING", "BLOCKED", "WAITING", "TERMINATED"];

function uid() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ── Thread class ───────────────────────────────────────────────────────────────
function makeThread(id, kernel = false) {
  return {
    id,
    label: kernel ? `KT-${id}` : `UT-${id}`,
    isKernel: kernel,
    state: "NEW",
    progress: 0,
    mappedTo: null, // for Many-to-One / Many-to-Many
    log: [],
    color: kernel ? COLOR.accent : COLOR.green,
    age: 0,
    semaphoreWait: null,
  };
}

// ── Semaphore ──────────────────────────────────────────────────────────────────
function makeSemaphore(name, value) {
  return { name, value, maxValue: value, queue: [] };
}

// ── Models ─────────────────────────────────────────────────────────────────────
const MODELS = {
  "Many-to-One": {
    desc: "All user threads map to a single kernel thread. Simple but no true parallelism.",
    kernelCount: 1,
    userCount: 4,
  },
  "One-to-One": {
    desc: "Each user thread maps to its own kernel thread. True parallelism; overhead per thread.",
    kernelCount: 4,
    userCount: 4,
  },
  "Many-to-Many": {
    desc: "User threads multiplexed over a pool of kernel threads. Flexible and efficient.",
    kernelCount: 2,
    userCount: 5,
  },
};

// ── Tiny log helper ────────────────────────────────────────────────────────────
function addLog(thread, msg) {
  thread.log = [`[${new Date().toLocaleTimeString("en",{hour12:false})}] ${msg}`, ...thread.log].slice(0, 8);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [model, setModel] = useState("Many-to-One");
  const [syncTool, setSyncTool] = useState("Semaphore"); // Semaphore | Monitor
  const [running, setRunning] = useState(false);
  const [threads, setThreads] = useState([]);
  const [kernels, setKernels] = useState([]);
  const [semaphores, setSemaphores] = useState([]);
  const [monitorLock, setMonitorLock] = useState(null); // thread id holding monitor
  const [monitorQueue, setMonitorQueue] = useState([]);
  const [tick, setTick] = useState(0);
  const [globalLog, setGlobalLog] = useState([]);
  const intervalRef = useRef(null);
  const stateRef = useRef({});

  // keep ref in sync
  useEffect(() => {
    stateRef.current = { threads, kernels, semaphores, monitorLock, monitorQueue };
  });

  // ── init ───────────────────────────────────────────────────────────────────
  const init = useCallback(() => {
    const cfg = MODELS[model];
    const ut = Array.from({ length: cfg.userCount }, (_, i) => makeThread(i + 1, false));
    const kt = Array.from({ length: cfg.kernelCount }, (_, i) => makeThread(i + 1, true));

    // mapping
    if (model === "Many-to-One") {
      ut.forEach(t => (t.mappedTo = kt[0].id));
    } else if (model === "One-to-One") {
      ut.forEach((t, i) => (t.mappedTo = kt[i].id));
    } else {
      ut.forEach((t, i) => (t.mappedTo = kt[i % kt.length].id));
    }

    const sems = [makeSemaphore("S1", 1), makeSemaphore("S2", 2)];
    setThreads(ut);
    setKernels(kt);
    setSemaphores(sems);
    setMonitorLock(null);
    setMonitorQueue([]);
    setTick(0);
    setGlobalLog([]);
    setRunning(false);
  }, [model]);

  useEffect(() => { init(); }, [init]);

  // ── tick logic ─────────────────────────────────────────────────────────────
  const doTick = useCallback(() => {
    setThreads(prev => {
      const next = prev.map(t => ({ ...t, log: [...t.log] }));
      const sem = stateRef.current.semaphores ? [...stateRef.current.semaphores.map(s => ({ ...s, queue: [...s.queue] }))] : [];
      let ml = stateRef.current.monitorLock;
      let mq = [...(stateRef.current.monitorQueue || [])];
      const logs = [];

      // Many-to-One: only 1 kernel → only 1 user can RUN at a time
      const cfg = MODELS[model];
      const maxRunning = cfg.kernelCount;

      const runningCount = next.filter(t => t.state === "RUNNING").length;

      next.forEach(t => {
        if (t.state === "TERMINATED") return;
        t.age++;

        // NEW → READY
        if (t.state === "NEW" && t.age > 1) {
          t.state = "READY";
          addLog(t, "Thread ready");
          logs.push(`${t.label} → READY`);
        }

        // READY → try RUNNING
        if (t.state === "READY") {
          const curRunning = next.filter(x => x.state === "RUNNING").length;
          if (curRunning < maxRunning) {
            // synchronization gating
            if (syncTool === "Semaphore") {
              const targetSem = sem[t.id % sem.length];
              if (targetSem.value > 0) {
                targetSem.value--;
                t.state = "RUNNING";
                t.semaphoreWait = targetSem.name;
                addLog(t, `Acquired ${targetSem.name} (val→${targetSem.value})`);
                logs.push(`${t.label} acquired ${targetSem.name}`);
              } else {
                t.state = "BLOCKED";
                if (!targetSem.queue.includes(t.id)) targetSem.queue.push(t.id);
                addLog(t, `Blocked on ${targetSem.name}`);
                logs.push(`${t.label} blocked on ${targetSem.name}`);
              }
            } else {
              // Monitor
              if (!ml) {
                ml = t.id;
                t.state = "RUNNING";
                addLog(t, "Entered monitor");
                logs.push(`${t.label} entered monitor`);
              } else if (ml !== t.id) {
                t.state = "WAITING";
                if (!mq.includes(t.id)) mq.push(t.id);
                addLog(t, "Waiting for monitor");
              }
            }
          }
        }

        // RUNNING → progress
        if (t.state === "RUNNING") {
          t.progress = Math.min(100, t.progress + Math.random() * 18 + 4);

          if (t.progress >= 100) {
            t.state = "TERMINATED";
            addLog(t, "Completed ✓");
            logs.push(`${t.label} TERMINATED`);

            // release semaphore
            if (syncTool === "Semaphore" && t.semaphoreWait) {
              const s = sem.find(x => x.name === t.semaphoreWait);
              if (s) {
                s.value = Math.min(s.maxValue, s.value + 1);
                if (s.queue.length > 0) {
                  const nextId = s.queue.shift();
                  const nextT = next.find(x => x.id === nextId);
                  if (nextT) {
                    nextT.state = "READY";
                    addLog(nextT, `Unblocked from ${s.name}`);
                    logs.push(`${nextT.label} unblocked`);
                  }
                }
              }
            }
            // release monitor
            if (syncTool === "Monitor" && ml === t.id) {
              ml = null;
              if (mq.length > 0) {
                const nextId = mq.shift();
                const nextT = next.find(x => x.id === nextId);
                if (nextT) {
                  nextT.state = "READY";
                  ml = null;
                  addLog(nextT, "Monitor released to me");
                  logs.push(`${nextT.label} got monitor`);
                }
              }
            }
          }
        }

        // Random BLOCKED→READY recovery
        if (t.state === "BLOCKED" && Math.random() < 0.12) {
          t.state = "READY";
          addLog(t, "Unblocked (I/O done)");
        }
      });

      setSemaphores(sem);
      setMonitorLock(ml);
      setMonitorQueue(mq);
      if (logs.length) {
        setGlobalLog(g => [...logs.reverse(), ...g].slice(0, 30));
      }
      return next;
    });

    setKernels(prev => {
      const cfg = MODELS[model];
      return prev.map((k, i) => {
        // pulse kernel activity
        return { ...k, state: "RUNNING", progress: (k.progress + 10) % 100 };
      });
    });

    setTick(t => t + 1);
  }, [model, syncTool]);

  // ── start/stop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(doTick, 600);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [running, doTick]);

  const allDone = threads.length > 0 && threads.every(t => t.state === "TERMINATED");
  useEffect(() => {
    if (allDone) setRunning(false);
  }, [allDone]);

  // ── render helpers ─────────────────────────────────────────────────────────
  const ThreadCard = ({ t }) => (
    <div style={{
      background: COLOR.panel,
      border: `1px solid ${t.state === "RUNNING" ? STATE_COLOR[t.state] : COLOR.border}`,
      borderRadius: 8,
      padding: "10px 12px",
      minWidth: 160,
      boxShadow: t.state === "RUNNING" ? `0 0 12px ${STATE_COLOR[t.state]}44` : "none",
      transition: "all 0.3s",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* scanline shimmer when running */}
      {t.state === "RUNNING" && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: "2px",
          background: STATE_COLOR[t.state],
          animation: "scan 1.2s linear infinite",
        }} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: t.color, fontWeight: 700 }}>
          {t.label}
        </span>
        <StateBadge state={t.state} />
      </div>
      <ProgressBar pct={t.progress} color={STATE_COLOR[t.state]} />
      <div style={{ marginTop: 6, fontSize: 10, color: COLOR.dim, fontFamily: "monospace" }}>
        {t.log[0] || "—"}
      </div>
      {t.mappedTo && (
        <div style={{ marginTop: 4, fontSize: 10, color: COLOR.accent }}>
          ↗ KT-{t.mappedTo}
        </div>
      )}
    </div>
  );

  const StateBadge = ({ state }) => (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: 1,
      color: STATE_COLOR[state],
      border: `1px solid ${STATE_COLOR[state]}`,
      borderRadius: 4, padding: "1px 5px",
      fontFamily: "monospace",
    }}>{state}</span>
  );

  const ProgressBar = ({ pct, color }) => (
    <div style={{ background: COLOR.muted, borderRadius: 3, height: 5, overflow: "hidden" }}>
      <div style={{
        width: `${pct}%`, height: "100%",
        background: color,
        borderRadius: 3,
        transition: "width 0.5s ease",
        boxShadow: `0 0 6px ${color}`,
      }} />
    </div>
  );

  const stateCounts = STATE_ORDER.map(s => ({
    s, count: threads.filter(t => t.state === s).length
  }));

  return (
    <div style={{
      minHeight: "100vh",
      background: COLOR.bg,
      color: COLOR.text,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      padding: "0 0 40px",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Orbitron:wght@700;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0a0c0f; } ::-webkit-scrollbar-thumb { background: #1e2530; }
        @keyframes scan { 0% { transform: translateY(-2px); opacity:1 } 100% { transform: translateY(200px); opacity:0 } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
        @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0 } }
        @keyframes fadeIn { from { opacity:0; transform: translateY(6px) } to { opacity:1; transform: none } }
      `}</style>

      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${COLOR.border}`,
        background: "#0c0e12",
        padding: "18px 32px",
        display: "flex", alignItems: "center", gap: 20,
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div>
          <div style={{ fontFamily: "'Orbitron', sans-serif", fontSize: 18, color: COLOR.accent, letterSpacing: 3 }}>
            THREAD//SIM
          </div>
          <div style={{ fontSize: 10, color: COLOR.dim, marginTop: 2 }}>Real-Time Multithreading Simulator</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: COLOR.dim }}>MODEL</span>
          {Object.keys(MODELS).map(m => (
            <button key={m} onClick={() => setModel(m)} style={{
              background: model === m ? COLOR.accent : "transparent",
              color: model === m ? COLOR.bg : COLOR.dim,
              border: `1px solid ${model === m ? COLOR.accent : COLOR.border}`,
              borderRadius: 5, padding: "4px 10px", fontSize: 10, cursor: "pointer",
              fontFamily: "monospace", fontWeight: 700, letterSpacing: 1,
              transition: "all 0.2s",
            }}>{m}</button>
          ))}
          <span style={{ fontSize: 10, color: COLOR.dim, marginLeft: 10 }}>SYNC</span>
          {["Semaphore", "Monitor"].map(s => (
            <button key={s} onClick={() => setSyncTool(s)} style={{
              background: syncTool === s ? COLOR.purple : "transparent",
              color: syncTool === s ? "#fff" : COLOR.dim,
              border: `1px solid ${syncTool === s ? COLOR.purple : COLOR.border}`,
              borderRadius: 5, padding: "4px 10px", fontSize: 10, cursor: "pointer",
              fontFamily: "monospace", fontWeight: 700,
              transition: "all 0.2s",
            }}>{s}</button>
          ))}
          <button onClick={() => setRunning(r => !r)} style={{
            background: running ? COLOR.red : COLOR.green,
            color: COLOR.bg, border: "none", borderRadius: 5,
            padding: "6px 16px", fontSize: 11, cursor: "pointer",
            fontFamily: "monospace", fontWeight: 700, letterSpacing: 1,
            boxShadow: `0 0 14px ${running ? COLOR.red : COLOR.green}66`,
            transition: "all 0.2s", marginLeft: 6,
          }}>
            {running ? "⏸ PAUSE" : allDone ? "↺ REPLAY" : "▶ START"}
          </button>
          <button onClick={init} style={{
            background: "transparent", color: COLOR.dim,
            border: `1px solid ${COLOR.border}`, borderRadius: 5,
            padding: "6px 12px", fontSize: 11, cursor: "pointer",
            fontFamily: "monospace",
          }}>RESET</button>
        </div>
      </div>

      <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Model description */}
        <div style={{
          background: `${COLOR.accent}11`,
          border: `1px solid ${COLOR.accent}33`,
          borderRadius: 8, padding: "10px 16px",
          fontSize: 12, color: COLOR.accent,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <span style={{ fontSize: 16 }}>◈</span>
          <div>
            <span style={{ fontWeight: 700 }}>{model}</span>
            {" — "}{MODELS[model].desc}
          </div>
          <div style={{ marginLeft: "auto", color: COLOR.dim, fontSize: 10 }}>
            TICK #{tick.toString().padStart(4, "0")} &nbsp;|&nbsp;
            {syncTool === "Semaphore" ? "🔒 Semaphore sync" : "🖥 Monitor sync"}
          </div>
        </div>

        {/* State summary bar */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {stateCounts.map(({ s, count }) => (
            <div key={s} style={{
              display: "flex", alignItems: "center", gap: 6,
              background: COLOR.panel, border: `1px solid ${COLOR.border}`,
              borderRadius: 6, padding: "5px 12px",
            }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: STATE_COLOR[s] }} />
              <span style={{ fontSize: 10, color: STATE_COLOR[s] }}>{s}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: count > 0 ? STATE_COLOR[s] : COLOR.muted }}>{count}</span>
            </div>
          ))}
        </div>

        {/* Main grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 280px", gap: 20 }}>
          {/* User Threads */}
          <div>
            <SectionLabel label="USER THREADS" color={COLOR.green} count={threads.length} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
              {threads.map(t => <ThreadCard key={t.id} t={t} />)}
            </div>
          </div>

          {/* Kernel Threads */}
          <div>
            <SectionLabel label="KERNEL THREADS" color={COLOR.accent} count={kernels.length} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
              {kernels.map(k => (
                <div key={k.id} style={{
                  background: COLOR.panel,
                  border: `1px solid ${COLOR.accent}44`,
                  borderRadius: 8, padding: "10px 12px", minWidth: 160,
                  boxShadow: `0 0 8px ${COLOR.accent}22`,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ color: COLOR.accent, fontWeight: 700, fontSize: 13 }}>KT-{k.id}</span>
                    <span style={{
                      fontSize: 9, color: COLOR.accent, border: `1px solid ${COLOR.accent}`,
                      borderRadius: 4, padding: "1px 5px",
                    }}>ACTIVE</span>
                  </div>
                  <div style={{ background: COLOR.muted, borderRadius: 3, height: 5, overflow: "hidden" }}>
                    <div style={{
                      width: `${k.progress}%`, height: "100%",
                      background: COLOR.accent, borderRadius: 3,
                      boxShadow: `0 0 6px ${COLOR.accent}`,
                      transition: "width 0.5s",
                    }} />
                  </div>
                  <div style={{ marginTop: 6, fontSize: 10, color: COLOR.dim }}>
                    Mapped: {threads.filter(t => t.mappedTo === k.id).map(t => t.label).join(", ") || "—"}
                  </div>
                </div>
              ))}
            </div>

            {/* Mapping diagram */}
            <div style={{ marginTop: 16 }}>
              <SectionLabel label="MAPPING" color={COLOR.yellow} />
              <div style={{
                background: COLOR.panel, border: `1px solid ${COLOR.border}`,
                borderRadius: 8, padding: 12, marginTop: 8, fontSize: 11,
              }}>
                {threads.map(t => (
                  <div key={t.id} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    marginBottom: 4, opacity: t.state === "TERMINATED" ? 0.3 : 1,
                    animation: "fadeIn 0.3s ease",
                  }}>
                    <span style={{ color: COLOR.green, minWidth: 50 }}>{t.label}</span>
                    <div style={{ flex: 1, height: 1, background: `${STATE_COLOR[t.state]}66`, position: "relative" }}>
                      <div style={{
                        position: "absolute", top: -3, left: "50%",
                        width: 6, height: 6, borderRadius: "50%",
                        background: STATE_COLOR[t.state],
                        animation: t.state === "RUNNING" ? "pulse 0.8s infinite" : "none",
                      }} />
                    </div>
                    <span style={{ color: COLOR.accent, minWidth: 50 }}>
                      {t.mappedTo ? `KT-${t.mappedTo}` : "—"}
                    </span>
                    <span style={{ fontSize: 9, color: STATE_COLOR[t.state] }}>{t.state}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right column: Sync + Log */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Semaphore / Monitor panel */}
            <div>
              <SectionLabel label={syncTool.toUpperCase()} color={COLOR.purple} />
              <div style={{
                background: COLOR.panel, border: `1px solid ${COLOR.purple}44`,
                borderRadius: 8, padding: 12, marginTop: 8,
              }}>
                {syncTool === "Semaphore" ? (
                  <>
                    {semaphores.map(s => (
                      <div key={s.name} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                          <span style={{ color: COLOR.purple }}>{s.name}</span>
                          <span style={{ color: s.value > 0 ? COLOR.green : COLOR.red }}>
                            {s.value}/{s.maxValue}
                          </span>
                        </div>
                        <div style={{ background: COLOR.muted, borderRadius: 3, height: 6, overflow: "hidden" }}>
                          <div style={{
                            width: `${(s.value / s.maxValue) * 100}%`, height: "100%",
                            background: s.value > 0 ? COLOR.purple : COLOR.red,
                            transition: "width 0.3s", borderRadius: 3,
                          }} />
                        </div>
                        {s.queue.length > 0 && (
                          <div style={{ fontSize: 9, color: COLOR.red, marginTop: 3 }}>
                            Waiting: {s.queue.map(id => `UT-${id}`).join(", ")}
                          </div>
                        )}
                      </div>
                    ))}
                    <div style={{ fontSize: 9, color: COLOR.dim, marginTop: 4 }}>
                      Semaphores prevent concurrent access. wait() decrements, signal() increments.
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{
                      padding: "8px 10px", borderRadius: 6,
                      background: monitorLock ? `${COLOR.green}11` : `${COLOR.red}11`,
                      border: `1px solid ${monitorLock ? COLOR.green : COLOR.red}33`,
                      marginBottom: 8,
                    }}>
                      <div style={{ fontSize: 10, color: COLOR.dim, marginBottom: 2 }}>LOCK HOLDER</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: monitorLock ? COLOR.green : COLOR.red }}>
                        {monitorLock ? `UT-${monitorLock}` : "UNLOCKED"}
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: COLOR.dim, marginBottom: 4 }}>WAIT QUEUE</div>
                    {monitorQueue.length === 0 ? (
                      <div style={{ fontSize: 10, color: COLOR.muted }}>empty</div>
                    ) : monitorQueue.map(id => (
                      <div key={id} style={{
                        fontSize: 10, color: COLOR.purple, padding: "2px 6px",
                        background: `${COLOR.purple}11`, borderRadius: 4, marginBottom: 3,
                      }}>UT-{id} waiting…</div>
                    ))}
                    <div style={{ fontSize: 9, color: COLOR.dim, marginTop: 8 }}>
                      Monitor allows only one thread inside at a time. Others wait() until notify().
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Event log */}
            <div style={{ flex: 1 }}>
              <SectionLabel label="EVENT LOG" color={COLOR.yellow} />
              <div style={{
                background: COLOR.panel, border: `1px solid ${COLOR.border}`,
                borderRadius: 8, padding: 10, marginTop: 8,
                maxHeight: 260, overflowY: "auto",
              }}>
                {globalLog.length === 0 ? (
                  <div style={{ color: COLOR.muted, fontSize: 10 }}>
                    <span style={{ animation: "blink 1s infinite", display: "inline-block" }}>▌</span> Awaiting events...
                  </div>
                ) : globalLog.map((l, i) => (
                  <div key={i} style={{
                    fontSize: 9, color: i === 0 ? COLOR.text : COLOR.dim,
                    padding: "2px 0", borderBottom: `1px solid ${COLOR.border}`,
                    animation: i === 0 ? "fadeIn 0.3s ease" : "none",
                  }}>{l}</div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Thread detail logs */}
        <div>
          <SectionLabel label="THREAD ACTIVITY LOGS" color={COLOR.dim} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10, marginTop: 10 }}>
            {threads.map(t => (
              <div key={t.id} style={{
                background: COLOR.panel, border: `1px solid ${COLOR.border}`,
                borderRadius: 8, padding: 10,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.color, marginBottom: 6 }}>{t.label}</div>
                {t.log.slice(0, 4).map((l, i) => (
                  <div key={i} style={{ fontSize: 9, color: i === 0 ? COLOR.text : COLOR.dim, marginBottom: 2 }}>{l}</div>
                ))}
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
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 3, height: 14, background: color, borderRadius: 2 }} />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color }}>{label}</span>
      {count !== undefined && (
        <span style={{ fontSize: 9, color: COLOR.dim, marginLeft: 4 }}>×{count}</span>
      )}
    </div>
  );
}
