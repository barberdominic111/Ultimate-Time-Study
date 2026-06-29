import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Legend, Cell
} from "recharts";

// ─── helpers ────────────────────────────────────────────────────────────────
const toSeconds = (v, unit) => {
  const n = parseFloat(v) || 0;
  if (unit === "min") return n * 60;
  if (unit === "hr")  return n * 3600;
  return n;
};

const fmt = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
};

const fmtMs = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
};

const stdDev = (arr) => {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
  return Math.sqrt(arr.reduce((a,b)=>a+(b-mean)**2,0)/arr.length);
};

// Normalize a comment for grouping: lowercase, strip punctuation, collapse whitespace.
const normalizeComment = (s) => {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

// ─── 8 wastes (TIMWOODS) ────────────────────────────────────────────────────
const WASTES = [
  { key: "normal",    label: "Normal",     icon: "✓",  color: "#10B981", group: "waste" },
  { key: "transport",  label: "Transport",  icon: "🚚", color: "#EF4444", group: "waste" },
  { key: "inventory",  label: "Inventory",  icon: "📦", color: "#EF4444", group: "waste" },
  { key: "motion",     label: "Motion",     icon: "🚶", color: "#EF4444", group: "waste" },
  { key: "waiting",    label: "Waiting",    icon: "⏳", color: "#EF4444", group: "waste" },
  { key: "overprod",   label: "Overprod.",  icon: "📈", color: "#EF4444", group: "waste" },
  { key: "overproc",   label: "Overproc.",  icon: "⚙️", color: "#EF4444", group: "waste" },
  { key: "defects",    label: "Defects",    icon: "⚠️", color: "#EF4444", group: "waste" },
  { key: "skills",     label: "Skills",     icon: "🧠", color: "#EF4444", group: "waste" },
];

// 4 general delay buttons — operator-utilization focused, separate pareto track
const DELAYS = [
  { key: "normal_delay",   label: "Normal",         icon: "✓",  color: "#10B981", group: "delay" },
  { key: "direct_delay",   label: "Direct Delay",   icon: "🟠", color: "#F59E0B", group: "delay" },
  { key: "indirect_delay", label: "Indirect Delay", icon: "🟣", color: "#A855F7", group: "delay" },
  { key: "troubleshoot",   label: "Troubleshoot",   icon: "🔧", color: "#0EA5E9", group: "delay" },
  { key: "fumble",         label: "Fumble",         icon: "🤚", color: "#64748B", group: "delay" },
];

const ALL_TAGS = [...WASTES, ...DELAYS];
const tagInfo = (key) => ALL_TAGS.find(t => t.key === key) || WASTES[0];
const isNormalTag = (key) => key === "normal" || key === "normal_delay";

// Arrange a tag list into a 3-column grid with the "normal" tag forced into the
// center cell of the middle row. Grid is sized to content (rounded up to a full
// row of 3), not padded out to a fixed 3x3 if there are fewer than 9 tags.
function centerNormalLayout(tags, normalKeyPredicate) {
  const normalTag = tags.find(t => normalKeyPredicate(t.key));
  const rest = tags.filter(t => !normalKeyPredicate(t.key));
  const total = rest.length + 1;
  const totalCells = total % 3 === 0 ? total : total + (3 - (total % 3));
  const centerIdx = Math.floor(totalCells / 2);
  const cells = new Array(totalCells).fill(null);
  cells[centerIdx] = normalTag;
  let ri = 0;
  for (let i = 0; i < totalCells; i++) {
    if (i === centerIdx) continue;
    if (ri < rest.length) { cells[i] = rest[ri]; ri++; }
  }
  return cells;
}

// ─── color logic ────────────────────────────────────────────────────────────
const stopwatchColor = (elapsed, target) => {
  if (!target) return "#1E293B";
  const pct = elapsed / target;
  if (pct < 0.8)  return "#10B981";
  if (pct < 0.9)  return "#F59E0B";
  return "#EF4444";
};

const earnedColor = (remaining, threshold) => {
  if (!threshold) return "#2563EB";
  const pct = remaining / threshold;
  if (pct > 0.2)  return "#10B981";
  if (pct > 0.1)  return "#F59E0B";
  return "#EF4444";
};

// Pace-rating color (MTM/MOST style — 100 = standard pace)
const paceColor = (pace) => {
  if (pace >= 110) return "#10B981"; // notably faster than standard
  if (pace >= 95)  return "#2563EB"; // around standard
  if (pace >= 85)  return "#F59E0B";
  return "#EF4444";
};

// ─── pareto helper ──────────────────────────────────────────────────────────
// Returns bars annotated with cumulative % and a flag for whether they fall within the 80% line.
function buildPareto(counts) {
  const total = counts.reduce((a, c) => a + c.count, 0);
  if (total === 0) return [];
  const sorted = [...counts].sort((a, b) => b.count - a.count);
  let cum = 0;
  return sorted.map(c => {
    cum += c.count;
    const cumPct = (cum / total) * 100;
    return { ...c, pct: (c.count / total) * 100, cumPct, in80: cumPct <= 80.0001 || (cum === c.count) };
  }).map((c, i, arr) => {
    // Ensure the first bar that PUSHES cumPct over 80 is still included (standard pareto convention:
    // include bars up through the one that crosses 80%).
    const priorCum = i === 0 ? 0 : arr[i-1].cumPct;
    return { ...c, in80: priorCum < 80 };
  });
}

// ─── localStorage ───────────────────────────────────────────────────────────
const STORAGE_KEY = "timestudy_sessions";
const loadSessions = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)||"[]"); } catch { return []; } };
const saveSessions = (s) => localStorage.setItem(STORAGE_KEY, JSON.stringify(s));

// ═══════════════════════════════════════════════════════════════════════════
// SETUP SCREEN
// ═══════════════════════════════════════════════════════════════════════════
function SetupScreen({ onStart }) {
  const [form, setForm] = useState({
    stationName: "", associateName: "", totalQty: "", shiftLength: "8",
    targetValue: "60", targetUnit: "sec",
    earnedValue: "300", earnedUnit: "sec",
  });

  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  const handleStart = () => {
    const targetSec = toSeconds(form.targetValue, form.targetUnit);
    const earnedSec = toSeconds(form.earnedValue, form.earnedUnit);
    if (!form.stationName || !targetSec) {
      alert("Station name and target cycle time are required.");
      return;
    }
    onStart({ ...form, targetSec, earnedSec, startedAt: Date.now() });
  };

  return (
    <div style={styles.page}>
      <div style={styles.setupCard}>
        <div style={styles.logoRow}>
          <span style={styles.logoIcon}>⏱</span>
          <span style={styles.logoText}>TimeStudy</span>
        </div>
        <h2 style={styles.setupTitle}>New Session</h2>

        <section style={styles.fieldGroup}>
          <label style={styles.label}>Station Name <span style={styles.req}>*</span></label>
          <input style={styles.input} value={form.stationName} onChange={e=>set("stationName",e.target.value)} placeholder="e.g. Station 3 – Final Assembly" />

          <label style={styles.label}>Associate Name <span style={styles.optional}>(optional)</span></label>
          <input style={styles.input} value={form.associateName} onChange={e=>set("associateName",e.target.value)} placeholder="e.g. J. Rivera" />
        </section>

        <section style={styles.fieldGroup}>
          <h3 style={styles.sectionHead}>Production</h3>
          <p style={styles.sectionDesc}>
            Used for line balancing math: takt time and required associates for this station.
            Leave blank if you're just timing cycles without a shift target.
          </p>
          <div style={styles.row2}>
            <div style={{flex:1}}>
              <label style={styles.label}>Total Qty Required</label>
              <input style={styles.input} type="number" min="1" value={form.totalQty} onChange={e=>set("totalQty",e.target.value)} placeholder="e.g. 240" />
            </div>
            <div style={{flex:1}}>
              <label style={styles.label}>Shift Length (hrs)</label>
              <input style={styles.input} type="number" min="1" max="24" value={form.shiftLength} onChange={e=>set("shiftLength",e.target.value)} />
            </div>
          </div>
        </section>

        <section style={styles.fieldGroup}>
          <h3 style={styles.sectionHead}>Target Cycle Time <span style={styles.req}>*</span></h3>
          <div style={styles.row2}>
            <input style={{...styles.input, flex:2}} type="number" min="0" step="0.1" value={form.targetValue} onChange={e=>set("targetValue",e.target.value)} />
            <select style={{...styles.input, flex:1}} value={form.targetUnit} onChange={e=>set("targetUnit",e.target.value)}>
              <option value="sec">sec</option>
              <option value="min">min</option>
              <option value="hr">hr</option>
            </select>
          </div>
          <p style={styles.hint}>= {fmt(toSeconds(form.targetValue,form.targetUnit))} (hh:mm:ss)</p>
        </section>

        <section style={styles.fieldGroup}>
          <h3 style={styles.sectionHead}>Earned Time Threshold</h3>
          <p style={styles.sectionDesc}>
            The "full bank" ceiling for the earned-time gauge below. It sets when the bank
            shows green/yellow/red — it doesn't cap how much you can actually earn.
          </p>
          <div style={styles.row2}>
            <input style={{...styles.input, flex:2}} type="number" min="0" step="0.1" value={form.earnedValue} onChange={e=>set("earnedValue",e.target.value)} />
            <select style={{...styles.input, flex:1}} value={form.earnedUnit} onChange={e=>set("earnedUnit",e.target.value)}>
              <option value="sec">sec</option>
              <option value="min">min</option>
              <option value="hr">hr</option>
            </select>
          </div>
          <p style={styles.hint}>= {fmt(toSeconds(form.earnedValue,form.earnedUnit))} (hh:mm:ss)</p>
        </section>

        <button style={styles.startBtn} onClick={handleStart}>START SESSION</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVE SESSION
// ═══════════════════════════════════════════════════════════════════════════
function ActiveSession({ config, onEnd }) {
  const [laps, setLaps] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const [earnedMs, setEarnedMs] = useState(0);
  const [usingEarned, setUsingEarned] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [tab, setTab] = useState("timer"); // timer | chart | pareto | balance
  const [paused, setPaused] = useState(false);
  const [buttonView, setButtonView] = useState("waste"); // waste | delay
  const [includeNormalInPareto, setIncludeNormalInPareto] = useState(false);

  const lapStartRef = useRef(Date.now());
  const earnedIntervalRef = useRef(null);
  const pausedAccumRef = useRef(0);   // ms accumulated in current cycle before a pause
  const pauseStartRef = useRef(null); // when current pause began

  // Main stopwatch — frozen while paused
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      setElapsed(Date.now() - lapStartRef.current - pausedAccumRef.current);
    }, 50);
    return () => clearInterval(id);
  }, [paused]);

  // Earned time countdown
  useEffect(() => {
    if (usingEarned && !exhausted) {
      earnedIntervalRef.current = setInterval(() => {
        setEarnedMs(prev => {
          if (prev <= 50) {
            setExhausted(true);
            setUsingEarned(false);
            return 0;
          }
          return prev - 50;
        });
      }, 50);
    } else {
      clearInterval(earnedIntervalRef.current);
    }
    return () => clearInterval(earnedIntervalRef.current);
  }, [usingEarned, exhausted]);

  const [activeTagKey, setActiveTagKey] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const frozenCycleRef = useRef(null);

  const recordLap = useCallback((tagKey, cycleMs, note = "") => {
    const cycleSec = cycleMs / 1000;
    const targetSec = config.targetSec;
    const earned = cycleSec < targetSec ? targetSec - cycleSec : 0;
    const tag = tagInfo(tagKey);

    setLaps(prev => [...prev, {
      n: prev.length + 1,
      cycleSec,
      timestamp: Date.now(),
      variance: cycleSec - targetSec,
      earnedSec: earned,
      tagKey,
      group: tag.group, // "waste" | "delay"
      note,
      disregard: false,
    }]);

    setEarnedMs(prev => prev + earned * 1000);
    setExhausted(false);
  }, [config.targetSec]);

  // Freeze clock + capture cycle the instant ANY button (waste or delay) is tapped.
  const handleTagTap = (key) => {
    const now = Date.now();
    const cycleMs = now - lapStartRef.current - pausedAccumRef.current;

    if (key === "normal" || key === "normal_delay") {
      recordLap(key, cycleMs, "");
      lapStartRef.current = now;
      pausedAccumRef.current = 0;
      setElapsed(0);
    } else {
      frozenCycleRef.current = { tagKey: key, cycleMs };
      setActiveTagKey(key);
      setNoteDraft("");
      // Next cycle starts now regardless of whether a note gets typed.
      lapStartRef.current = now;
      pausedAccumRef.current = 0;
      setElapsed(0);
    }
  };

  const confirmTagCycle = () => {
    const frozen = frozenCycleRef.current;
    if (frozen) recordLap(frozen.tagKey, frozen.cycleMs, noteDraft.trim());
    frozenCycleRef.current = null;
    setActiveTagKey(null);
    setNoteDraft("");
  };

  const skipTagNote = () => {
    const frozen = frozenCycleRef.current;
    if (frozen) recordLap(frozen.tagKey, frozen.cycleMs, "");
    frozenCycleRef.current = null;
    setActiveTagKey(null);
    setNoteDraft("");
  };

  // Pause / resume — freezes the visible clock without creating a lap.
  const togglePause = () => {
    if (paused) {
      // resuming: add the time we spent paused to the accumulator so it's excluded from the cycle
      const pausedFor = Date.now() - pauseStartRef.current;
      pausedAccumRef.current += pausedFor;
      pauseStartRef.current = null;
      setPaused(false);
    } else {
      pauseStartRef.current = Date.now();
      setPaused(true);
    }
  };

  // Disregard toggle — marks a past lap as disregarded without deleting or re-timing it.
  const toggleDisregard = (n) => {
    setLaps(prev => prev.map(l => l.n === n ? { ...l, disregard: !l.disregard } : l));
  };

  const elapsedSec = elapsed / 1000;
  const swColor = paused ? "#94A3B8" : stopwatchColor(elapsedSec, config.targetSec);
  const eColor  = earnedColor(earnedMs/1000, config.earnedSec);

  // ── Analytics (disregarded laps excluded from all stats/charts) ───────────
  const validLaps = laps.filter(l => !l.disregard);
  const times = validLaps.map(l=>l.cycleSec);
  const avg   = times.length ? times.reduce((a,b)=>a+b,0)/times.length : 0;
  const best  = times.length ? Math.min(...times) : 0;
  const worst = times.length ? Math.max(...times) : 0;
  const sd    = stdDev(times);
  const metPct = times.length ? (times.filter(t=>t<=config.targetSec).length/times.length*100).toFixed(0) : 0;
  const totalEarnedSec = validLaps.reduce((a,l)=>a+l.earnedSec,0);

  // Pace rating (MTM/MOST style): 100 = standard. Faster than target => >100.
  const paceRating = avg > 0 && config.targetSec > 0 ? (config.targetSec / avg) * 100 : null;

  // Chart data (normal cycles only get plotted as the "performance" line; disregarded excluded already)
  const movingAvg = validLaps.map((lap, i) => {
    const window = validLaps.slice(Math.max(0,i-4), i+1).map(l=>l.cycleSec);
    return { n: i+1, cycle: lap.cycleSec, ma: window.reduce((a,b)=>a+b,0)/window.length, avg };
  });

  // Box-and-whisker summary (single station) — quartiles, IQR whiskers, outliers.
  const shiftSec = parseFloat(config.shiftLength) * 3600;
  const taktTime  = config.totalQty ? shiftSec / config.totalQty : null;
  const reqAssoc  = (config.totalQty && avg) ? (config.totalQty * avg) / shiftSec : null;

  const boxStats = useMemo(() => {
    if (times.length < 3) return null;
    const sorted = [...times].sort((a,b)=>a-b);
    const quantile = (arr, q) => {
      const pos = (arr.length - 1) * q;
      const base = Math.floor(pos);
      const rest = pos - base;
      return arr[base + 1] !== undefined ? arr[base] + rest * (arr[base+1]-arr[base]) : arr[base];
    };
    const q1 = quantile(sorted, 0.25);
    const median = quantile(sorted, 0.5);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5*iqr;
    const upperFence = q3 + 1.5*iqr;
    const withinLow = sorted.filter(v => v >= lowerFence);
    const withinHigh = sorted.filter(v => v <= upperFence);
    const whiskerLow = withinLow.length ? Math.min(...withinLow) : sorted[0];
    const whiskerHigh = withinHigh.length ? Math.max(...withinHigh) : sorted[sorted.length-1];
    const outliers = sorted.filter(v => v < whiskerLow || v > whiskerHigh);
    return { min: sorted[0], max: sorted[sorted.length-1], q1, median, q3, iqr, whiskerLow, whiskerHigh, outliers, n: sorted.length };
  }, [times]);

  // ── Two-stage paretos ──────────────────────────────────────────────────────
  // Downtime pareto: built from WASTE tags (+ optionally "normal"), excludes delay-group cycles entirely.
  const downtimePareto = useMemo(() => {
    const pool = validLaps.filter(l => l.group === "waste" && (includeNormalInPareto || !isNormalTag(l.tagKey)));
    const counts = WASTES
      .filter(w => includeNormalInPareto || !isNormalTag(w.key))
      .map(w => ({ key: w.key, label: w.label, icon: w.icon, count: pool.filter(l=>l.tagKey===w.key).length }))
      .filter(w => w.count > 0);
    return buildPareto(counts);
  }, [validLaps, includeNormalInPareto]);

  const downtimeStage2 = useMemo(() => {
    const topKeys = downtimePareto.filter(b => b.in80).map(b => b.key);
    if (topKeys.length === 0) return [];
    const pool = validLaps.filter(l => topKeys.includes(l.tagKey));
    const byComment = new Map();
    pool.forEach(l => {
      const norm = normalizeComment(l.note);
      const label = norm === "" ? "Undefined" : norm;
      byComment.set(label, (byComment.get(label) || 0) + 1);
    });
    const counts = [...byComment.entries()].map(([label, count]) => ({ key: label, label, icon: "💬", count }));
    return buildPareto(counts);
  }, [downtimePareto, validLaps]);

  // Utilization pareto: built from DELAY tags only (excludes "Normal" — that's not a utilization issue).
  const utilizationPareto = useMemo(() => {
    const pool = validLaps.filter(l => l.group === "delay" && !isNormalTag(l.tagKey));
    const counts = DELAYS
      .filter(d => !isNormalTag(d.key))
      .map(d => ({ key: d.key, label: d.label, icon: d.icon, count: pool.filter(l=>l.tagKey===d.key).length }))
      .filter(d => d.count > 0);
    return buildPareto(counts);
  }, [validLaps]);

  const utilizationStage2 = useMemo(() => {
    const topKeys = utilizationPareto.filter(b => b.in80).map(b => b.key);
    if (topKeys.length === 0) return [];
    const pool = validLaps.filter(l => topKeys.includes(l.tagKey));
    const byComment = new Map();
    pool.forEach(l => {
      const norm = normalizeComment(l.note);
      const label = norm === "" ? "Undefined" : norm;
      byComment.set(label, (byComment.get(label) || 0) + 1);
    });
    const counts = [...byComment.entries()].map(([label, count]) => ({ key: label, label, icon: "💬", count }));
    return buildPareto(counts);
  }, [utilizationPareto, validLaps]);

  // ── Operator Utilization summary (pie + timeline) ──────────────────────────
  // Utilized = Normal + any of the 8 wastes (work was happening, even if imperfect).
  // Unutilized = any of the 4 delay types (work was not happening at all).
  const utilizationSummary = useMemo(() => {
    const utilizedLaps = validLaps.filter(l => l.group === "waste");
    const unutilizedLaps = validLaps.filter(l => l.group === "delay" && !isNormalTag(l.tagKey));
    // Note: "Normal" tapped from the Delays view (normal_delay) is still utilized time —
    // it represents a clean cycle, just logged from the other button screen.
    const normalDelayLaps = validLaps.filter(l => l.tagKey === "normal_delay");

    const utilizedSec = utilizedLaps.reduce((a,l)=>a+l.cycleSec,0) + normalDelayLaps.reduce((a,l)=>a+l.cycleSec,0);
    const unutilizedSec = unutilizedLaps.reduce((a,l)=>a+l.cycleSec,0);
    const totalSec = utilizedSec + unutilizedSec;

    const pieData = totalSec > 0 ? [
      { key: "utilized", label: "Utilized", value: utilizedSec, color: "#10B981" },
      { key: "unutilized", label: "Unutilized", value: unutilizedSec, color: "#EF4444" },
    ].filter(d => d.value > 0) : [];

    // Timeline blocks in chronological order, each carrying a start/end wall-clock time.
    const blocks = [...validLaps]
      .sort((a,b) => a.timestamp - b.timestamp)
      .map(l => {
        const tag = tagInfo(l.tagKey);
        const utilized = l.group === "waste" || l.tagKey === "normal_delay";
        return {
          n: l.n,
          start: l.timestamp - l.cycleSec * 1000,
          end: l.timestamp,
          durationSec: l.cycleSec,
          utilized,
          tagKey: l.tagKey,
          label: tag.label,
          color: utilized ? (isNormalTag(l.tagKey) ? "#10B981" : tag.color) : tag.color,
        };
      });

    const sessionStart = blocks.length ? Math.min(...blocks.map(b=>b.start)) : null;
    const sessionEnd = blocks.length ? Math.max(...blocks.map(b=>b.end)) : null;

    return {
      utilizedSec, unutilizedSec, totalSec,
      utilizedPct: totalSec ? (utilizedSec/totalSec*100) : 0,
      unutilizedPct: totalSec ? (unutilizedSec/totalSec*100) : 0,
      pieData, blocks, sessionStart, sessionEnd,
    };
  }, [validLaps]);

  // ── Full CSV export: session config, every raw lap, summary stats, and both paretos ──
  const exportEverything = () => {
    const esc = (v) => `"${String(v).replace(/"/g,'""')}"`;
    const section = (title) => [[`# ${title}`]];
    const blank = [[]];
    let rows = [];

    rows.push(...section("SESSION"));
    rows.push(
      ["Station", config.stationName],
      ["Associate", config.associateName || ""],
      ["Target Cycle (s)", config.targetSec.toFixed(2)],
      ["Earned Time Threshold (s)", config.earnedSec.toFixed(2)],
      ["Total Qty Required", config.totalQty || ""],
      ["Shift Length (hrs)", config.shiftLength || ""],
      ["Started At", new Date(config.startedAt).toLocaleString()],
      ["Exported At", new Date().toLocaleString()],
    );
    rows.push(...blank);

    rows.push(...section("SUMMARY STATS"));
    rows.push(
      ["Valid Cycles (n)", validLaps.length],
      ["Disregarded Cycles", laps.length - validLaps.length],
      ["Avg Cycle (s)", avg.toFixed(2)],
      ["Best Cycle (s)", best.toFixed(2)],
      ["Worst Cycle (s)", worst.toFixed(2)],
      ["Std Dev (s)", sd.toFixed(2)],
      ["% On Target", metPct],
      ["Total Earned Time (s)", totalEarnedSec.toFixed(2)],
      ["Pace Rating", paceRating !== null ? paceRating.toFixed(1) : ""],
      ["Takt Time (s)", taktTime ? taktTime.toFixed(2) : ""],
      ["Required Associates", reqAssoc !== null ? reqAssoc.toFixed(2) : ""],
    );
    rows.push(...blank);

    if (boxStats) {
      rows.push(...section("BOX & WHISKER"));
      rows.push(
        ["Min (s)", boxStats.min.toFixed(2)],
        ["Whisker Low (s)", boxStats.whiskerLow.toFixed(2)],
        ["Q1 (s)", boxStats.q1.toFixed(2)],
        ["Median (s)", boxStats.median.toFixed(2)],
        ["Q3 (s)", boxStats.q3.toFixed(2)],
        ["Whisker High (s)", boxStats.whiskerHigh.toFixed(2)],
        ["Max (s)", boxStats.max.toFixed(2)],
        ["IQR (s)", boxStats.iqr.toFixed(2)],
        ["Outliers (s)", boxStats.outliers.map(o=>o.toFixed(2)).join("; ")],
      );
      rows.push(...blank);
    }

    rows.push(...section("DOWNTIME PARETO — STAGE 1 (Waste Categories)"));
    rows.push(["Category", "Count", "% of Total", "Cumulative %", "In Top 80%"]);
    downtimePareto.forEach(b => rows.push([b.label, b.count, b.pct.toFixed(1), b.cumPct.toFixed(1), b.in80 ? "Yes" : "No"]));
    rows.push(...blank);

    if (downtimeStage2.length > 0) {
      rows.push(...section("DOWNTIME PARETO — STAGE 2 (Comment Reasons)"));
      rows.push(["Comment (normalized)", "Count", "% of Total", "Cumulative %", "In Top 80%"]);
      downtimeStage2.forEach(b => rows.push([b.label, b.count, b.pct.toFixed(1), b.cumPct.toFixed(1), b.in80 ? "Yes" : "No"]));
      rows.push(...blank);
    }

    rows.push(...section("UTILIZATION PARETO — STAGE 1 (Delay Categories)"));
    rows.push(["Category", "Count", "% of Total", "Cumulative %", "In Top 80%"]);
    utilizationPareto.forEach(b => rows.push([b.label, b.count, b.pct.toFixed(1), b.cumPct.toFixed(1), b.in80 ? "Yes" : "No"]));
    rows.push(...blank);

    if (utilizationStage2.length > 0) {
      rows.push(...section("UTILIZATION PARETO — STAGE 2 (Comment Reasons)"));
      rows.push(["Comment (normalized)", "Count", "% of Total", "Cumulative %", "In Top 80%"]);
      utilizationStage2.forEach(b => rows.push([b.label, b.count, b.pct.toFixed(1), b.cumPct.toFixed(1), b.in80 ? "Yes" : "No"]));
      rows.push(...blank);
    }

    rows.push(...section("OPERATOR UTILIZATION"));
    rows.push(
      ["Utilized Time (s)", utilizationSummary.utilizedSec.toFixed(2)],
      ["Unutilized Time (s)", utilizationSummary.unutilizedSec.toFixed(2)],
      ["Total Time (s)", utilizationSummary.totalSec.toFixed(2)],
      ["% Utilized", utilizationSummary.utilizedPct.toFixed(1)],
      ["% Unutilized", utilizationSummary.unutilizedPct.toFixed(1)],
    );
    rows.push(...blank);

    rows.push(...section("RAW LAP DATA"));
    rows.push(["#", "Cycle Time (s)", "Variance (s)", "Earned (s)", "Group", "Tag", "Note", "Disregarded", "Timestamp"]);
    laps.forEach(l => rows.push([
      l.n, l.cycleSec.toFixed(2), l.variance.toFixed(2), l.earnedSec.toFixed(2),
      l.group, tagInfo(l.tagKey).label, l.note || "", l.disregard ? "Yes" : "No",
      new Date(l.timestamp).toLocaleString(),
    ]));

    const csv = rows.map(r => r.map(esc).join(",")).join("\n");
    const blob = new Blob([csv], {type:"text/csv"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${config.stationName.replace(/\s+/g,"_")}_full_export.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleEndSession = () => {
    const sessions = loadSessions();
    sessions.push({ config, laps, savedAt: Date.now(), paceRating });
    saveSessions(sessions);
    onEnd();
  };

  const tagsForView = buttonView === "waste" ? WASTES : DELAYS;
  const gridCells = useMemo(() => centerNormalLayout(tagsForView, isNormalTag), [tagsForView]);

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.sessionHeader}>
        <div>
          <div style={styles.sessionTitle}>{config.stationName}</div>
          {config.associateName && <div style={styles.sessionSub}>{config.associateName}</div>}
        </div>
        <div style={styles.lapBadge}>{validLaps.length} cycles</div>
        <button style={styles.headerExportBtn} onClick={exportEverything} title="Export all data as CSV">⬇</button>
        <button style={styles.endBtn} onClick={handleEndSession}>END</button>
      </div>

      {/* Tab bar */}
      <div style={styles.tabBar}>
        {["timer","chart","pareto","utilization","balance"].map(t => (
          <button key={t} style={tab===t ? styles.tabActive : styles.tab} onClick={()=>setTab(t)}>
            {t === "timer" ? "⏱ Timer" : t === "chart" ? "📈 Chart" : t === "pareto" ? "📊 Pareto" : t === "utilization" ? "🟢 Utilization" : "⚖️ Balance"}
          </button>
        ))}
      </div>

      {/* TIMER TAB */}
      {tab === "timer" && (
        <div style={styles.timerPane}>

          {/* Main stopwatch */}
          <div style={styles.swCard}>
            <div style={styles.swLabelRow}>
              <span style={styles.swLabel}>CYCLE TIME</span>
              {paused && <span style={styles.pausedChip}>⏸ PAUSED</span>}
            </div>
            <div style={{...styles.swDisplay, color: swColor}}>
              {fmtMs(elapsed)}
            </div>
            <div style={styles.swMeta}>
              Target: {fmt(config.targetSec)}
              {config.targetSec > 0 && !paused && (
                <span style={{color: swColor, marginLeft:12, fontWeight:700}}>
                  {elapsedSec <= config.targetSec
                    ? `–${fmt(config.targetSec - elapsedSec)} remaining`
                    : `+${fmt(elapsedSec - config.targetSec)} over`}
                </span>
              )}
            </div>
            <div style={styles.colorBar}>
              <div style={{...styles.colorBarFill, width: `${Math.min(100, (elapsedSec/config.targetSec)*100)}%`, background: swColor}} />
            </div>

            <button style={styles.pauseBtn} onClick={togglePause}>
              {paused ? "▶ RESUME" : "⏸ PAUSE"}
            </button>
          </div>

          {/* Toggle: Wastes view <-> Delays view */}
          <div style={styles.viewToggleRow}>
            <button
              style={buttonView==="waste" ? styles.viewToggleActive : styles.viewToggle}
              onClick={()=>setButtonView("waste")}
            >8 Wastes</button>
            <button
              style={buttonView==="delay" ? styles.viewToggleActive : styles.viewToggle}
              onClick={()=>setButtonView("delay")}
            >Delays</button>
          </div>

          {/* Complete Cycle — Normal centered, other tags smaller around it */}
          <div style={styles.wasteGrid}>
            {gridCells.map((w, i) => {
              if (!w) return <div key={`empty-${i}`} />;
              const normal = isNormalTag(w.key);
              return (
                <button
                  key={w.key}
                  style={{
                    ...(normal ? styles.wasteBtnNormal : styles.wasteBtn),
                    borderColor: w.color,
                  }}
                  onClick={() => handleTagTap(w.key)}
                >
                  <span style={normal ? styles.wasteIconNormal : styles.wasteIcon}>{w.icon}</span>
                  <span style={normal ? styles.wasteLabelNormal : styles.wasteLabel}>{w.label}</span>
                </button>
              );
            })}
          </div>
          <p style={styles.wasteHint}>
            {buttonView === "waste"
              ? <>Tap <strong>Normal</strong> for a clean cycle, or a waste type to log why it didn't go as planned.</>
              : <>Tap <strong>Normal</strong> for a clean cycle, or a delay type when work isn't happening at all — tracked separately for operator utilization.</>}
          </p>

          {/* Disregard-last shortcut */}
          {laps.length > 0 && (
            <button
              style={styles.disregardBtn}
              onClick={() => toggleDisregard(laps[laps.length-1].n)}
            >
              {laps[laps.length-1].disregard ? "↩ Restore last capture" : "✕ Disregard last capture (wrong button)"}
            </button>
          )}

          {/* Tag note modal */}
          {activeTagKey && (
            <div style={styles.modalOverlay} onClick={skipTagNote}>
              <div style={styles.modalCard} onClick={e=>e.stopPropagation()}>
                <div style={styles.modalTitle}>
                  {tagInfo(activeTagKey).icon} {tagInfo(activeTagKey).label}
                </div>
                <p style={styles.modalSub}>Cycle logged. What happened? (optional — next cycle is already timing)</p>
                <textarea
                  style={styles.modalTextarea}
                  rows={3}
                  autoFocus
                  value={noteDraft}
                  onChange={e=>setNoteDraft(e.target.value)}
                  placeholder="e.g. Had to walk to parts bin, empty rack"
                />
                <div style={styles.modalBtnRow}>
                  <button style={styles.modalCancel} onClick={skipTagNote}>Skip note</button>
                  <button style={styles.modalConfirm} onClick={confirmTagCycle}>Save note</button>
                </div>
              </div>
            </div>
          )}

          {/* Earned Time */}
          <div style={{...styles.swCard, marginTop:16}}>
            <div style={styles.swLabel}>EARNED TIME BANK</div>
            <div style={{...styles.swDisplay, fontSize:"clamp(2rem,8vw,4rem)", color: eColor}}>
              {fmt(earnedMs/1000)}
            </div>
            {exhausted && (
              <div style={styles.exhaustedBanner}>⚠ Earned Time Exhausted</div>
            )}
            <button
              style={{...styles.earnedBtn, background: usingEarned ? "#EF4444" : "#2563EB"}}
              onClick={() => { setUsingEarned(u=>!u); setExhausted(false); }}
              disabled={earnedMs <= 0}
            >
              {usingEarned ? "⏸ PAUSE EARNED TIME" : "▶ START USING EARNED TIME"}
            </button>
          </div>

          {/* Pace factor */}
          {paceRating !== null && (
            <div style={{...styles.swCard, marginTop:16}}>
              <div style={styles.swLabel}>SKILL & EFFORT — PACE RATING</div>
              <div style={{...styles.swDisplay, fontSize:"clamp(2rem,8vw,3.5rem)", color: paceColor(paceRating)}}>
                {paceRating.toFixed(0)}
              </div>
              <p style={styles.paceHint}>
                100 = standard pace (matches target). Above 100 = faster than target;
                below 100 = slower. Based on {validLaps.length} valid cycle{validLaps.length!==1?"s":""}, avg {fmt(avg)} vs target {fmt(config.targetSec)}.
              </p>
            </div>
          )}

          {/* Quick stats */}
          <div style={styles.statsGrid}>
            {[
              ["Cycles",      validLaps.length],
              ["Avg",         avg ? fmt(avg) : "—"],
              ["Best",        best ? fmt(best) : "—"],
              ["Worst",       worst ? fmt(worst) : "—"],
              ["Std Dev",     sd ? `${sd.toFixed(1)}s` : "—"],
              ["On Target",   `${metPct}%`],
            ].map(([k,v])=>(
              <div key={k} style={styles.statCell}>
                <div style={styles.statVal}>{v}</div>
                <div style={styles.statKey}>{k}</div>
              </div>
            ))}
          </div>

          {/* Recent laps */}
          {laps.length > 0 && (
            <div style={styles.lapTable}>
              <div style={styles.lapTableHead}>
                <span>#</span><span>Cycle</span><span>Variance</span><span>Tag</span>
              </div>
              {[...laps].reverse().slice(0,12).map(l=>{
                const w = tagInfo(l.tagKey);
                return (
                <div
                  key={l.n}
                  style={{
                    ...styles.lapRow,
                    borderLeft:`4px solid ${l.disregard ? "#94A3B8" : (isNormalTag(l.tagKey)?"#10B981":"#EF4444")}`,
                    opacity: l.disregard ? 0.45 : 1,
                    cursor: "pointer",
                  }}
                  onClick={() => toggleDisregard(l.n)}
                  title={l.disregard ? "Tap to restore" : "Tap to disregard"}
                >
                  <span style={{color:"#64748B"}}>{l.n}</span>
                  <span style={{fontFamily:"DM Mono, monospace", fontWeight:600, textDecoration: l.disregard ? "line-through" : "none"}}>{fmt(l.cycleSec)}</span>
                  <span style={{color: l.variance<=0?"#10B981":"#EF4444", fontFamily:"DM Mono,monospace"}}>
                    {l.disregard ? "—" : <>{l.variance<=0?"–":"+"}{fmt(Math.abs(l.variance))}</>}
                  </span>
                  <span style={{fontSize:12}} title={l.note}>
                    {l.disregard ? "Disregarded" : <>{w.icon} {!isNormalTag(l.tagKey) ? w.label : fmt(l.earnedSec)}</>}
                  </span>
                </div>
              );})}
            </div>
          )}
        </div>
      )}

      {/* CHART TAB */}
      {tab === "chart" && (
        <div style={styles.timerPane}>
          {validLaps.length < 2 ? (
            <div style={styles.emptyState}>Complete at least 2 valid cycles to see the run chart.</div>
          ) : (
            <>
              <div style={styles.chartCard}>
                <div style={styles.swLabel}>RUN CHART — Cycle Time vs Target</div>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={movingAvg} margin={{top:10,right:20,left:0,bottom:10}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="n" label={{value:"Cycle #", position:"insideBottomRight", offset:-10, fill:"#94A3B8", fontSize:12}} tick={{fill:"#64748B",fontSize:11}} />
                    <YAxis tickFormatter={v=>fmt(v)} tick={{fill:"#64748B",fontSize:11}} width={70}/>
                    <Tooltip formatter={(v,n)=>[fmt(v), n==="cycle"?"Cycle":n==="ma"?"Moving Avg":"Overall Avg"]} labelFormatter={l=>`Cycle ${l}`}/>
                    <Legend />
                    <ReferenceLine y={config.targetSec} stroke="#EF4444" strokeDasharray="6 3" label={{value:"Target",fill:"#EF4444",fontSize:11}} />
                    <Line type="monotone" dataKey="cycle" stroke="#2563EB" dot={{r:4,fill:"#2563EB"}} strokeWidth={2} name="Cycle" />
                    <Line type="monotone" dataKey="ma" stroke="#F59E0B" dot={false} strokeWidth={2} strokeDasharray="5 3" name="Moving Avg" />
                    <Line type="monotone" dataKey="avg" stroke="#10B981" dot={false} strokeWidth={1.5} strokeDasharray="3 3" name="Overall Avg" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div style={styles.statsGrid}>
                {[
                  ["Avg Cycle",    fmt(avg)],
                  ["Best",         fmt(best)],
                  ["Worst",        fmt(worst)],
                  ["Std Dev",      `${sd.toFixed(1)}s`],
                  ["On Target",    `${metPct}%`],
                  ["Total Earned", fmt(totalEarnedSec)],
                ].map(([k,v])=>(
                  <div key={k} style={styles.statCell}>
                    <div style={styles.statVal}>{v}</div>
                    <div style={styles.statKey}>{k}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* PARETO TAB */}
      {tab === "pareto" && (
        <div style={styles.timerPane}>

          {/* ── Downtime pareto (wastes) ───────────────────────────────── */}
          <div style={styles.chartCard}>
            <div style={styles.swLabelRow}>
              <span style={styles.swLabel}>STAGE 1 — DOWNTIME PARETO (How Each Lap Finished)</span>
            </div>
            <label style={styles.checkboxRow}>
              <input type="checkbox" checked={includeNormalInPareto} onChange={e=>setIncludeNormalInPareto(e.target.checked)} />
              Include "Normal" in this pareto
            </label>

            {downtimePareto.length === 0 ? (
              <div style={styles.emptyStateSmall}>No waste-tagged cycles yet.</div>
            ) : (
              <ParetoWaterfallChart data={downtimePareto} />
            )}
          </div>

          {downtimeStage2.length > 0 && (
            <div style={{...styles.chartCard, marginTop:14}}>
              <div style={styles.swLabel}>STAGE 2 — TOP CATEGORY REASONS (Comments)</div>
              <p style={styles.wasteHint2}>
                Built only from the categories that made up the top 80% above: {downtimePareto.filter(b=>b.in80).map(b=>b.label).join(", ")}.
              </p>
              <ParetoWaterfallChart data={downtimeStage2} barColor="#0EA5E9" />
            </div>
          )}

          {/* ── Utilization pareto (delays) ───────────────────────────── */}
          <div style={{...styles.chartCard, marginTop:20}}>
            <div style={styles.swLabel}>STAGE 1 — OPERATOR UTILIZATION PARETO (Delays)</div>
            {utilizationPareto.length === 0 ? (
              <div style={styles.emptyStateSmall}>No delay-tagged cycles yet. Switch to "Delays" view on the Timer tab to log these.</div>
            ) : (
              <ParetoWaterfallChart data={utilizationPareto} barColor="#F59E0B" />
            )}
          </div>

          {utilizationStage2.length > 0 && (
            <div style={{...styles.chartCard, marginTop:14}}>
              <div style={styles.swLabel}>STAGE 2 — TOP DELAY REASONS (Comments)</div>
              <p style={styles.wasteHint2}>
                Built only from the delay types that made up the top 80% above: {utilizationPareto.filter(b=>b.in80).map(b=>b.label).join(", ")}.
              </p>
              <ParetoWaterfallChart data={utilizationStage2} barColor="#A855F7" />
            </div>
          )}
        </div>
      )}

      {/* UTILIZATION TAB */}
      {tab === "utilization" && (
        <div style={styles.timerPane}>
          {utilizationSummary.totalSec === 0 ? (
            <div style={styles.emptyState}>Complete at least one cycle to see operator utilization.</div>
          ) : (
            <>
              <div style={styles.chartCard}>
                <div style={styles.swLabel}>OPERATOR UTILIZATION</div>
                <p style={styles.wasteHint2}>
                  Utilized = Normal cycles and the 8 wastes (work was happening, even if imperfectly).
                  Unutilized = the 4 delay types (work was not happening at all).
                </p>

                <div style={styles.utilSplitRow}>
                  <div style={styles.utilSplitCell}>
                    <div style={{...styles.utilSplitVal, color:"#10B981"}}>{utilizationSummary.utilizedPct.toFixed(0)}%</div>
                    <div style={styles.utilSplitKey}>Utilized — {fmt(utilizationSummary.utilizedSec)}</div>
                  </div>
                  <div style={styles.utilSplitCell}>
                    <div style={{...styles.utilSplitVal, color:"#EF4444"}}>{utilizationSummary.unutilizedPct.toFixed(0)}%</div>
                    <div style={styles.utilSplitKey}>Unutilized — {fmt(utilizationSummary.unutilizedSec)}</div>
                  </div>
                </div>

                <UtilizationPie data={utilizationSummary.pieData} />
              </div>

              <div style={{...styles.chartCard, marginTop:14}}>
                <div style={styles.swLabel}>TIMELINE — Utilized Above, Unutilized Below</div>
                <p style={styles.wasteHint2}>
                  Each block is one captured cycle, plotted at its real clock time and sized to its duration.
                </p>
                <UtilizationTimeline
                  blocks={utilizationSummary.blocks}
                  sessionStart={utilizationSummary.sessionStart}
                  sessionEnd={utilizationSummary.sessionEnd}
                />
                <TimelineLegend blocks={utilizationSummary.blocks} />
              </div>
            </>
          )}
        </div>
      )}

      {/* BALANCE TAB */}
      {tab === "balance" && (
        <div style={styles.timerPane}>
          {!boxStats ? (
            <div style={styles.emptyState}>Complete at least 3 valid cycles to see the box-and-whisker summary.</div>
          ) : (
            <>
              <div style={styles.balanceCard}>
                <div style={styles.swLabelRow}>
                  <span style={styles.swLabel}>BOX & WHISKER — {config.stationName}</span>
                  <button style={styles.exportBtn} onClick={exportEverything}>⬇ Export Everything (CSV)</button>
                </div>
                <p style={styles.wasteHint2}>
                  Summarized cycle-time distribution from {boxStats.n} valid cycle{boxStats.n!==1?"s":""}.
                </p>
                <BoxWhiskerPlot stats={boxStats} target={config.targetSec} />

                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>Min</span>
                  <span style={styles.balVal}>{fmt(boxStats.min)}</span>
                </div>
                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>Whisker Low</span>
                  <span style={styles.balVal}>{fmt(boxStats.whiskerLow)}</span>
                </div>
                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>Q1 (25th pct)</span>
                  <span style={styles.balVal}>{fmt(boxStats.q1)}</span>
                </div>
                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>Median</span>
                  <span style={styles.balVal}>{fmt(boxStats.median)}</span>
                </div>
                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>Q3 (75th pct)</span>
                  <span style={styles.balVal}>{fmt(boxStats.q3)}</span>
                </div>
                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>Whisker High</span>
                  <span style={styles.balVal}>{fmt(boxStats.whiskerHigh)}</span>
                </div>
                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>Max</span>
                  <span style={styles.balVal}>{fmt(boxStats.max)}</span>
                </div>
                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>IQR</span>
                  <span style={styles.balVal}>{boxStats.iqr.toFixed(1)}s</span>
                </div>
                {boxStats.outliers.length > 0 && (
                  <div style={styles.balanceRow}>
                    <span style={styles.balKey}>Outliers</span>
                    <span style={{...styles.balVal, color:"#EF4444"}}>{boxStats.outliers.map(o=>fmt(o)).join(", ")}</span>
                  </div>
                )}
              </div>

              <div style={{...styles.balanceCard, marginTop:14}}>
                <div style={styles.swLabel}>SUPPORTING DATA</div>
                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>Average Cycle</span>
                  <span style={styles.balVal}>{fmt(avg)}</span>
                </div>
                <div style={styles.balanceRow}>
                  <span style={styles.balKey}>Std Dev</span>
                  <span style={styles.balVal}>{sd.toFixed(1)}s</span>
                </div>
                {paceRating !== null && (
                  <div style={styles.balanceRow}>
                    <span style={styles.balKey}>Pace Rating</span>
                    <span style={{...styles.balVal, color: paceColor(paceRating)}}>{paceRating.toFixed(0)}</span>
                  </div>
                )}
                {taktTime && (
                  <div style={styles.balanceRow}>
                    <span style={styles.balKey}>Takt Time</span>
                    <span style={styles.balVal}>{fmt(taktTime)}</span>
                  </div>
                )}
                {reqAssoc !== null && (
                  <div style={styles.balanceRow}>
                    <span style={styles.balKey}>Required Associates (this station)</span>
                    <span style={styles.balVal}>{reqAssoc.toFixed(2)}</span>
                  </div>
                )}
                <div style={styles.formulaBox}>
                  <div style={styles.formulaTitle}>Formulas Used</div>
                  <div style={styles.formulaLine}>Whiskers = Q1/Q3 ± 1.5 × IQR (Tukey method)</div>
                  <div style={styles.formulaLine}>Takt Time = Shift Length ÷ Total Qty Required</div>
                  <div style={styles.formulaLine}>Required Associates = (Qty × Avg Cycle) ÷ Shift Length</div>
                  <div style={styles.formulaLine}>Pace Rating = (Target Cycle ÷ Avg Cycle) × 100</div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PARETO CHART (bars + cumulative % line, 80% reference)
// ═══════════════════════════════════════════════════════════════════════════
function ParetoChart({ data, barColor = "#2563EB" }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{top:10,right:20,left:0,bottom:40}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
        <XAxis dataKey="label" tick={{fill:"#64748B",fontSize:10}} angle={-30} textAnchor="end" interval={0} />
        <YAxis yAxisId="left" tick={{fill:"#64748B",fontSize:11}} allowDecimals={false} />
        <YAxis yAxisId="right" orientation="right" domain={[0,100]} tick={{fill:"#94A3B8",fontSize:11}} tickFormatter={v=>`${v}%`} />
        <Tooltip formatter={(v,n)=> n==="count" ? [v,"Count"] : [`${v.toFixed(0)}%`,"Cumulative"]} />
        {/* Fixed 80% threshold for reference — NOT the data line itself */}
        <ReferenceLine yAxisId="right" y={80} stroke="#EF4444" strokeDasharray="4 4" label={{value:"80% threshold",fill:"#EF4444",fontSize:11,position:"right"}} />
        <Bar yAxisId="left" dataKey="count" name="count" radius={[4,4,0,0]}>
          {data.map((d,i)=><Cell key={i} fill={d.in80 ? barColor : "#CBD5E1"} />)}
        </Bar>
        {/* The actual cumulative % climb — each point is this bar's running total, drawn as
            sharp steps so it's visibly climbing (e.g. 50% -> 60% -> 70% -> 80% -> 92% -> 100%)
            rather than reading as a flat reference line. */}
        <Line yAxisId="right" type="stepAfter" data={data} dataKey="cumPct" name="cumPct" stroke="#0F172A" strokeWidth={2.5} dot={{r:4,fill:"#0F172A"}} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PARETO WATERFALL — each bar floats from its running-total start to its
// running-total end, so you can see exactly which categories stack together
// to cross the 80% threshold. Same 80% reference line as the bar version.
// ═══════════════════════════════════════════════════════════════════════════
function ParetoWaterfallChart({ data, barColor = "#2563EB" }) {
  // Build floating-bar data: "base" is the invisible riser, "rise" is the visible
  // segment from prior cumulative % to this category's cumulative %.
  const waterfallData = data.map((d, i) => {
    const base = i === 0 ? 0 : data[i-1].cumPct;
    return { ...d, base, rise: d.cumPct - base };
  });

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={waterfallData} margin={{top:10,right:20,left:0,bottom:40}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
        <XAxis dataKey="label" tick={{fill:"#64748B",fontSize:10}} angle={-30} textAnchor="end" interval={0} />
        <YAxis domain={[0,100]} tick={{fill:"#64748B",fontSize:11}} tickFormatter={v=>`${v}%`} width={42} />
        <Tooltip
          content={({active, payload}) => {
            if (!active || !payload || !payload.length) return null;
            const d = payload[0].payload;
            return (
              <div style={{background:"#FFFFFF", border:"1px solid #E2E8F0", borderRadius:8, padding:"8px 12px", fontSize:12}}>
                <div style={{fontWeight:700, marginBottom:4}}>{d.label}</div>
                <div>Count: {d.count}</div>
                <div>Adds: {d.pct.toFixed(1)}%</div>
                <div>Running total: {d.cumPct.toFixed(1)}%</div>
              </div>
            );
          }}
        />
        <ReferenceLine y={80} stroke="#EF4444" strokeDasharray="4 4" label={{value:"80% threshold",fill:"#EF4444",fontSize:11,position:"right"}} />
        {/* invisible riser to float each bar at the right height */}
        <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
        {/* the visible segment showing this category's contribution to the running total */}
        <Bar dataKey="rise" stackId="wf" radius={[4,4,0,0]} isAnimationActive={false}>
          {waterfallData.map((d,i)=><Cell key={i} fill={d.in80 ? barColor : "#CBD5E1"} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HORIZONTAL BOX & WHISKER PLOT (SVG)
// ═══════════════════════════════════════════════════════════════════════════
function BoxWhiskerPlot({ stats, target }) {
  const { min, max, q1, median, q3, whiskerLow, whiskerHigh, outliers } = stats;
  const W = 600, H = 140;
  const padL = 50, padR = 30;
  const plotW = W - padL - padR;
  const midY = H / 2;
  const boxH = 44;

  const domainMin = Math.min(min, target || min) * 0.95;
  const domainMax = Math.max(max, target || max) * 1.05;
  const scale = (v) => padL + ((v - domainMin) / (domainMax - domainMin)) * plotW;

  const ticks = 5;
  const tickVals = Array.from({length: ticks+1}, (_,i) => domainMin + (domainMax-domainMin)*(i/ticks));

  return (
    <div style={{overflowX:"auto", marginBottom: 16}}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{minWidth: 480}}>
        {/* gridlines + axis labels */}
        {tickVals.map((t,i) => (
          <g key={i}>
            <line x1={scale(t)} x2={scale(t)} y1={20} y2={H-20} stroke="#F1F5F9" strokeWidth={1} />
            <text x={scale(t)} y={H-6} fontSize={10} fill="#94A3B8" textAnchor="middle" fontFamily="DM Mono, monospace">
              {fmt(t)}
            </text>
          </g>
        ))}

        {/* target reference line */}
        {target > 0 && (
          <g>
            <line x1={scale(target)} x2={scale(target)} y1={20} y2={H-20} stroke="#EF4444" strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={scale(target)} y={14} fontSize={10} fill="#EF4444" textAnchor="middle" fontWeight="700">target</text>
          </g>
        )}

        {/* whisker line: whiskerLow -> whiskerHigh */}
        <line x1={scale(whiskerLow)} x2={scale(whiskerHigh)} y1={midY} y2={midY} stroke="#0F172A" strokeWidth={1.5} />
        {/* whisker caps */}
        <line x1={scale(whiskerLow)} x2={scale(whiskerLow)} y1={midY-12} y2={midY+12} stroke="#0F172A" strokeWidth={1.5} />
        <line x1={scale(whiskerHigh)} x2={scale(whiskerHigh)} y1={midY-12} y2={midY+12} stroke="#0F172A" strokeWidth={1.5} />

        {/* box: q1 -> q3 */}
        <rect
          x={scale(q1)} y={midY - boxH/2}
          width={Math.max(2, scale(q3)-scale(q1))} height={boxH}
          fill="#DBEAFE" stroke="#2563EB" strokeWidth={1.5}
        />
        {/* median line */}
        <line x1={scale(median)} x2={scale(median)} y1={midY-boxH/2} y2={midY+boxH/2} stroke="#2563EB" strokeWidth={2.5} />

        {/* outliers */}
        {outliers.map((o,i) => (
          <circle key={i} cx={scale(o)} cy={midY} r={4} fill="#FFFFFF" stroke="#EF4444" strokeWidth={1.5} />
        ))}

        {/* labels above */}
        <text x={scale(q1)} y={midY-boxH/2-8} fontSize={10} fill="#64748B" textAnchor="middle" fontFamily="DM Mono, monospace">Q1</text>
        <text x={scale(median)} y={midY-boxH/2-8} fontSize={10} fill="#2563EB" textAnchor="middle" fontWeight="700" fontFamily="DM Mono, monospace">Med</text>
        <text x={scale(q3)} y={midY-boxH/2-8} fontSize={10} fill="#64748B" textAnchor="middle" fontFamily="DM Mono, monospace">Q3</text>
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILIZATION PIE (standard pie chart, SVG)
// ═══════════════════════════════════════════════════════════════════════════
function UtilizationPie({ data }) {
  const size = 200, r = 90, cx = size/2, cy = size/2;
  const total = data.reduce((a,d)=>a+d.value,0);
  if (total === 0) return null;

  let angle = -90; // start at 12 o'clock
  const slices = data.map(d => {
    const sweep = (d.value/total) * 360;
    const startAngle = angle;
    const endAngle = angle + sweep;
    angle = endAngle;
    const toXY = (a) => {
      const rad = (a * Math.PI) / 180;
      return [cx + r*Math.cos(rad), cy + r*Math.sin(rad)];
    };
    const [x1,y1] = toXY(startAngle);
    const [x2,y2] = toXY(endAngle);
    const largeArc = sweep > 180 ? 1 : 0;
    const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    const midAngle = (startAngle+endAngle)/2;
    const [lx,ly] = toXY(midAngle * 0.97);
    return { ...d, path, pct: (d.value/total)*100, lx, ly };
  });

  return (
    <div style={{display:"flex", alignItems:"center", gap:20, flexWrap:"wrap", justifyContent:"center"}}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {slices.map((s,i) => <path key={i} d={s.path} fill={s.color} stroke="#FFFFFF" strokeWidth={2} />)}
        {slices.map((s,i) => s.pct > 6 ? (
          <text key={`l-${i}`} x={s.lx} y={s.ly} fontSize={13} fontWeight="800" fill="#FFFFFF" textAnchor="middle" dominantBaseline="middle">
            {s.pct.toFixed(0)}%
          </text>
        ) : null)}
      </svg>
      <div style={{display:"flex", flexDirection:"column", gap:8}}>
        {data.map(d => (
          <div key={d.key} style={{display:"flex", alignItems:"center", gap:8}}>
            <span style={{width:12, height:12, borderRadius:3, background:d.color, display:"inline-block"}} />
            <span style={{fontSize:13, fontWeight:600, color:"#475569"}}>{d.label}</span>
            <span style={{fontSize:12, color:"#94A3B8", fontFamily:"DM Mono, monospace"}}>{fmt(d.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILIZATION TIMELINE — utilized blocks above the axis, unutilized below
// ═══════════════════════════════════════════════════════════════════════════
function UtilizationTimeline({ blocks, sessionStart, sessionEnd }) {
  if (!blocks.length || sessionStart === null) return null;
  const W = 600, H = 180;
  const padL = 10, padR = 10, padTop = 16, padBottom = 16;
  const axisY = H/2;
  const plotW = W - padL - padR;
  const span = Math.max(1, sessionEnd - sessionStart);
  const scaleX = (t) => padL + ((t - sessionStart)/span) * plotW;
  const maxBarH = (H/2) - padTop;

  // Scale block height by duration relative to the longest block, so long delays/wastes stand out.
  const maxDuration = Math.max(...blocks.map(b=>b.durationSec), 1);
  const barH = (durationSec) => Math.max(6, (durationSec/maxDuration) * maxBarH);

  // Wall-clock tick marks (start, middle, end)
  const ticks = [sessionStart, sessionStart + span/2, sessionEnd];
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"});

  return (
    <div style={{overflowX:"auto"}}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{minWidth: 480}}>
        {/* center axis */}
        <line x1={padL} x2={W-padR} y1={axisY} y2={axisY} stroke="#CBD5E1" strokeWidth={1.5} />

        {/* tick labels */}
        {ticks.map((t,i) => (
          <g key={i}>
            <line x1={scaleX(t)} x2={scaleX(t)} y1={axisY-3} y2={axisY+3} stroke="#94A3B8" strokeWidth={1} />
            <text x={scaleX(t)} y={H-2} fontSize={9} fill="#94A3B8" textAnchor="middle" fontFamily="DM Mono, monospace">
              {fmtClock(t)}
            </text>
          </g>
        ))}

        {/* blocks */}
        {blocks.map((b,i) => {
          const x = scaleX(b.start);
          const w = Math.max(1.5, scaleX(b.end) - scaleX(b.start));
          const h = barH(b.durationSec);
          const y = b.utilized ? axisY - h : axisY;
          return (
            <rect key={i} x={x} y={y} width={w} height={h} fill={b.color} opacity={0.9}>
              <title>{`#${b.n} ${b.label} — ${fmt(b.durationSec)}`}</title>
            </rect>
          );
        })}

        {/* axis labels */}
        <text x={padL} y={padTop-4} fontSize={10} fontWeight="700" fill="#10B981">UTILIZED</text>
        <text x={padL} y={H-padBottom+12} fontSize={10} fontWeight="700" fill="#EF4444">UNUTILIZED</text>
      </svg>
    </div>
  );
}

function TimelineLegend({ blocks }) {
  const seen = new Map();
  blocks.forEach(b => { if (!seen.has(b.tagKey)) seen.set(b.tagKey, b); });
  const items = [...seen.values()];
  return (
    <div style={{display:"flex", flexWrap:"wrap", gap:10, marginTop:10, justifyContent:"center"}}>
      {items.map(b => (
        <div key={b.tagKey} style={{display:"flex", alignItems:"center", gap:5}}>
          <span style={{width:10, height:10, borderRadius:2, background:b.color, display:"inline-block"}} />
          <span style={{fontSize:11, color:"#64748B", fontWeight:600}}>{b.label}</span>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [config, setConfig] = useState(null);

  if (!config) return <SetupScreen onStart={setConfig} />;
  return <ActiveSession config={config} onEnd={() => setConfig(null)} />;
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════
const styles = {
  page: {
    minHeight: "100vh",
    background: "#F8FAFC",
    fontFamily: "Inter, system-ui, sans-serif",
    color: "#1E293B",
  },
  setupCard: { maxWidth: 540, margin: "0 auto", padding: "24px 20px 48px" },
  logoRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 24 },
  logoIcon: { fontSize: 28 },
  logoText: { fontFamily: "DM Mono, monospace", fontWeight: 700, fontSize: 22, letterSpacing: "-0.5px", color: "#2563EB" },
  setupTitle: { fontSize: 26, fontWeight: 700, marginBottom: 24, color: "#0F172A" },
  fieldGroup: {
    background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12,
    padding: "16px 18px", marginBottom: 14, display: "flex", flexDirection: "column", gap: 10,
  },
  sectionHead: { fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748B", margin: 0 },
  sectionDesc: { fontSize: 12.5, color: "#94A3B8", margin: "-4px 0 2px", lineHeight: 1.4 },
  label: { fontSize: 13, fontWeight: 600, color: "#475569", marginBottom: 2 },
  req: { color: "#EF4444" },
  optional: { fontWeight: 400, color: "#94A3B8", fontSize: 12 },
  input: {
    border: "1.5px solid #CBD5E1", borderRadius: 8, padding: "10px 12px", fontSize: 15,
    fontFamily: "Inter, system-ui, sans-serif", color: "#1E293B", background: "#F8FAFC",
    outline: "none", width: "100%", boxSizing: "border-box",
  },
  row2: { display: "flex", gap: 10 },
  hint: { fontSize: 12, color: "#94A3B8", margin: 0, fontFamily: "DM Mono, monospace" },
  startBtn: {
    width: "100%", padding: "18px", background: "#2563EB", color: "#FFFFFF", border: "none",
    borderRadius: 12, fontSize: 18, fontWeight: 800, letterSpacing: "0.05em", cursor: "pointer", marginTop: 8,
  },

  sessionHeader: {
    background: "#FFFFFF", borderBottom: "1px solid #E2E8F0", padding: "14px 18px",
    display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 10,
  },
  sessionTitle: { fontSize: 17, fontWeight: 700, color: "#0F172A" },
  sessionSub: { fontSize: 13, color: "#64748B", marginTop: 1 },
  lapBadge: {
    marginLeft: "auto", background: "#EFF6FF", color: "#2563EB", fontWeight: 700, fontSize: 13,
    padding: "4px 12px", borderRadius: 20, fontFamily: "DM Mono, monospace",
  },
  endBtn: {
    background: "#FEF2F2", color: "#EF4444", border: "1.5px solid #FECACA", borderRadius: 8,
    padding: "6px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer",
  },
  headerExportBtn: {
    background: "#EFF6FF", color: "#2563EB", border: "1.5px solid #BFDBFE", borderRadius: 8,
    padding: "6px 10px", fontWeight: 700, fontSize: 14, cursor: "pointer",
  },
  tabBar: { display: "flex", background: "#FFFFFF", borderBottom: "1px solid #E2E8F0", overflowX: "auto" },
  tab: {
    flex: 1, padding: "12px 4px", background: "none", border: "none", borderBottom: "3px solid transparent",
    cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#64748B", whiteSpace: "nowrap",
  },
  tabActive: {
    flex: 1, padding: "12px 4px", background: "none", border: "none", borderBottom: "3px solid #2563EB",
    cursor: "pointer", fontSize: 13, fontWeight: 700, color: "#2563EB", whiteSpace: "nowrap",
  },
  timerPane: { maxWidth: 600, margin: "0 auto", padding: "16px 14px 48px" },
  swCard: { background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 16, padding: "20px", marginBottom: 12 },
  swLabelRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  swLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#94A3B8", textTransform: "uppercase" },
  pausedChip: {
    fontSize: 11, fontWeight: 800, color: "#FFFFFF", background: "#94A3B8",
    padding: "3px 10px", borderRadius: 20, letterSpacing: "0.05em",
  },
  swDisplay: {
    fontFamily: "DM Mono, monospace", fontSize: "clamp(2.8rem, 12vw, 5.5rem)", fontWeight: 700,
    lineHeight: 1, letterSpacing: "-1px", transition: "color 0.3s",
  },
  swMeta: { fontSize: 13, color: "#64748B", marginTop: 10, fontFamily: "DM Mono, monospace" },
  colorBar: { height: 6, background: "#E2E8F0", borderRadius: 3, marginTop: 12, overflow: "hidden" },
  colorBarFill: { height: "100%", borderRadius: 3, transition: "width 0.1s, background 0.3s" },
  pauseBtn: {
    width: "100%", marginTop: 14, padding: "12px", borderRadius: 10, border: "1.5px solid #CBD5E1",
    background: "#F8FAFC", color: "#475569", fontWeight: 700, fontSize: 14, cursor: "pointer",
  },

  viewToggleRow: { display: "flex", gap: 8, marginBottom: 10 },
  viewToggle: {
    flex: 1, padding: "10px", borderRadius: 10, border: "1.5px solid #E2E8F0", background: "#FFFFFF",
    color: "#64748B", fontWeight: 700, fontSize: 13, cursor: "pointer",
  },
  viewToggleActive: {
    flex: 1, padding: "10px", borderRadius: 10, border: "1.5px solid #2563EB", background: "#EFF6FF",
    color: "#2563EB", fontWeight: 700, fontSize: 13, cursor: "pointer",
  },

  wasteGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 8 },
  wasteBtnNormal: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: 4, padding: "20px 8px", background: "#10B981", border: "2px solid #10B981", borderRadius: 14,
    color: "#FFFFFF", cursor: "pointer", boxShadow: "0 4px 16px rgba(16,185,129,0.25)",
    aspectRatio: "1 / 1",
  },
  wasteBtn: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
    padding: "10px 4px", background: "#FFFFFF", border: "2px solid #FECACA", borderRadius: 12,
    color: "#1E293B", cursor: "pointer",
    aspectRatio: "1 / 1",
    transform: "scale(0.75)", // 25% smaller than the Normal button
  },
  wasteIcon: { fontSize: 16 },
  wasteIconNormal: { fontSize: 22 },
  wasteLabel: { fontSize: 9, fontWeight: 700, textAlign: "center" },
  wasteLabelNormal: { fontSize: 11, fontWeight: 700, textAlign: "center" },
  wasteHint: { fontSize: 12, color: "#94A3B8", textAlign: "center", margin: "6px 0 14px" },
  wasteHint2: { fontSize: 12, color: "#94A3B8", margin: "0 0 10px" },

  disregardBtn: {
    width: "100%", padding: "12px", borderRadius: 10, border: "1.5px dashed #CBD5E1", background: "#F8FAFC",
    color: "#64748B", fontWeight: 700, fontSize: 13, cursor: "pointer", marginBottom: 14,
  },

  checkboxRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#475569", fontWeight: 600, marginBottom: 12 },

  paceHint: { fontSize: 12, color: "#94A3B8", marginTop: 10, lineHeight: 1.5 },

  modalOverlay: {
    position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex",
    alignItems: "center", justifyContent: "center", padding: 20, zIndex: 100,
  },
  modalCard: { background: "#FFFFFF", borderRadius: 16, padding: 22, width: "100%", maxWidth: 420 },
  modalTitle: { fontSize: 18, fontWeight: 800, marginBottom: 4 },
  modalSub: { fontSize: 13, color: "#64748B", marginTop: 0, marginBottom: 10 },
  modalTextarea: {
    width: "100%", border: "1.5px solid #CBD5E1", borderRadius: 10, padding: 12, fontSize: 14,
    fontFamily: "Inter, system-ui, sans-serif", boxSizing: "border-box", resize: "vertical", outline: "none",
  },
  modalBtnRow: { display: "flex", gap: 10, marginTop: 14 },
  modalCancel: { flex: 1, padding: "12px", borderRadius: 10, border: "1.5px solid #E2E8F0", background: "#FFFFFF", color: "#64748B", fontWeight: 700, cursor: "pointer" },
  modalConfirm: { flex: 1, padding: "12px", borderRadius: 10, border: "none", background: "#EF4444", color: "#FFFFFF", fontWeight: 700, cursor: "pointer" },

  statsGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 14 },
  utilSplitRow: { display: "flex", gap: 12, marginBottom: 16 },
  utilSplitCell: { flex: 1, background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 12, padding: "14px", textAlign: "center" },
  utilSplitVal: { fontFamily: "DM Mono, monospace", fontSize: 28, fontWeight: 800 },
  utilSplitKey: { fontSize: 12, color: "#64748B", marginTop: 4, fontWeight: 600 },
  statCell: { background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: "14px 10px", textAlign: "center" },
  statVal: { fontFamily: "DM Mono, monospace", fontSize: 16, fontWeight: 700, color: "#0F172A" },
  statKey: { fontSize: 11, color: "#94A3B8", marginTop: 4, fontWeight: 600, textTransform:"uppercase", letterSpacing:"0.05em" },

  lapTable: { marginTop: 16, background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 12, overflow: "hidden" },
  lapTableHead: {
    display: "grid", gridTemplateColumns: "40px 1fr 1fr 1fr", padding: "10px 14px", background: "#F8FAFC",
    borderBottom: "1px solid #E2E8F0", fontSize: 11, fontWeight: 700, color: "#94A3B8",
    textTransform: "uppercase", letterSpacing: "0.06em",
  },
  lapRow: {
    display: "grid", gridTemplateColumns: "40px 1fr 1fr 1fr", padding: "12px 14px",
    borderBottom: "1px solid #F1F5F9", fontSize: 14, alignItems: "center",
  },

  chartCard: { background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 16, padding: "20px", marginBottom: 16 },
  emptyState: {
    textAlign: "center", color: "#94A3B8", fontSize: 15, padding: "60px 24px",
    background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 16,
  },
  emptyStateSmall: { textAlign: "center", color: "#94A3B8", fontSize: 13, padding: "24px 12px" },

  balanceCard: { background: "#FFFFFF", border: "1px solid #E2E8F0", borderRadius: 16, padding: "20px" },
  exportBtn: {
    background: "#EFF6FF", color: "#2563EB", border: "1.5px solid #BFDBFE", borderRadius: 8,
    padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
  },
  balanceRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #F1F5F9" },
  balKey: { fontSize: 14, color: "#475569", fontWeight: 600 },
  balVal: { fontFamily: "DM Mono, monospace", fontSize: 16, fontWeight: 700, color: "#0F172A" },
  staffBadge: { marginTop: 18, padding: "14px", borderRadius: 10, color: "#FFFFFF", fontWeight: 800, fontSize: 18, textAlign: "center", letterSpacing: "0.02em" },
  formulaBox: { marginTop: 18, background: "#F8FAFC", borderRadius: 10, padding: "14px 16px" },
  formulaTitle: { fontSize: 11, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 },
  formulaLine: { fontSize: 12, color: "#64748B", fontFamily: "DM Mono, monospace", marginBottom: 4 },
};

