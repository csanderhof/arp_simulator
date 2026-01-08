import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * ARP Simulator — Step-by-step UI (single-file React)
 *
 * Includes requested upgrades:
 * - Switch larger
 * - 4 PCs aligned on a straight line with spacing
 * - Visual route: highlighted path + moving packet dot
 * - Colors: broadcast/request = yellow, reply = green
 * - "Pause on switch" like Packet Tracer (brief dwell at SW)
 * - Ethernet vs ARP layer toggle in frame-details panel
 */

const BROADCAST = "ff:ff:ff:ff:ff:ff";
const ZEROMAC = "00:00:00:00:00:00";

function hex16(n) {
  return "0x" + n.toString(16).padStart(4, "0");
}

function now() {
  return new Date().toLocaleTimeString();
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function formatFrame(frame) {
  const { eth, arp } = frame;
  const op = arp.opcode === 1 ? "request" : arp.opcode === 2 ? "reply" : String(arp.opcode);
  return {
    ethernet: [`Dst: ${eth.dst}`, `Src: ${eth.src}`, `Type: ${hex16(eth.type)} (ARP)`].join("\n"),
    arp: [
      `htype: ${arp.htype} (Ethernet)`,
      `ptype: ${hex16(arp.ptype)} (IPv4)`,
      `hlen:  ${arp.hlen}`,
      `plen:  ${arp.plen}`,
      `opcode: ${arp.opcode} (${op})`,
      `SHA: ${arp.sha}`,
      `SPA: ${arp.spa}`,
      `THA: ${arp.tha}`,
      `TPA: ${arp.tpa}`
    ].join("\n")
  };
}

function makeRequest(sender, targetIp) {
  return {
    kind: "ARP_REQUEST",
    title: `ARP Request (broadcast): Who has ${targetIp}? Tell ${sender.ip}`,
    frame: {
      eth: { dst: BROADCAST, src: sender.mac, type: 0x0806 },
      arp: {
        htype: 1,
        ptype: 0x0800,
        hlen: 6,
        plen: 4,
        opcode: 1,
        sha: sender.mac,
        spa: sender.ip,
        tha: ZEROMAC,
        tpa: targetIp
      }
    }
  };
}

function makeReply(target, requester) {
  return {
    kind: "ARP_REPLY",
    title: `ARP Reply (unicast): ${target.ip} is at ${target.mac}`,
    frame: {
      eth: { dst: requester.mac, src: target.mac, type: 0x0806 },
      arp: {
        htype: 1,
        ptype: 0x0800,
        hlen: 6,
        plen: 4,
        opcode: 2,
        sha: target.mac,
        spa: target.ip,
        tha: requester.mac,
        tpa: requester.ip
      }
    }
  };
}

function pill(text) {
  return (
    <span className="inline-flex items-center rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/90">
      {text}
    </span>
  );
}

function PanelCard({ title, children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-white">{title}</div>
      </div>
      {children}
    </div>
  );
}

export default function App() {
  // Layout: Switch above, PCs in a straight line with spacing
  const nodes = useMemo(() => {
    const pcY = 470;
    const swY = 240;
    const baseX = 240;
    const gap = 240;

    const pc = (i, id, ip, mac) => ({ id, name: id, type: "pc", x: baseX + gap * i, y: pcY, ip, mac });

    return {
      SW1: { id: "SW1", name: "Switch1", type: "switch", x: baseX + gap * 1.5, y: swY, mac: "02:aa:bb:cc:dd:f1" },
      PC1: pc(0, "PC1", "192.168.1.10", "00:1a:2b:3c:4d:10"),
      PC2: pc(1, "PC2", "192.168.1.20", "00:1a:2b:3c:4d:20"),
      PC3: pc(2, "PC3", "192.168.1.30", "00:1a:2b:3c:4d:30"),
      PC4: pc(3, "PC4", "192.168.1.40", "00:1a:2b:3c:4d:40")
    };
  }, []);

  const links = useMemo(
    () => [
      { a: "SW1", b: "PC1" },
      { a: "SW1", b: "PC2" },
      { a: "SW1", b: "PC3" },
      { a: "SW1", b: "PC4" }
    ],
    []
  );

  const initialCaches = useMemo(() => ({ PC1: {}, PC2: {}, PC3: {}, PC4: {} }), []);

  const [zoom, setZoom] = useState(0.75);
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState(null);
  const [layerTab, setLayerTab] = useState("both"); // ethernet | arp | both
  const [eventLog, setEventLog] = useState([]);
  const [arpCaches, setArpCaches] = useState(initialCaches);

  const senderId = "PC1";
  const targetId = "PC3";
  const sender = nodes[senderId];
  const target = nodes[targetId];

  const script = useMemo(() => {
    const s = [];
    s.push({ kind: "START", title: `${sender.name} wants to send IPv4 traffic to ${target.ip}` });
    s.push({ kind: "CACHE_CHECK", title: `${sender.name} checks ARP cache for ${target.ip}` });
    s.push({ kind: "CACHE_MISS", title: `Cache miss -> ${sender.name} must ARP for ${target.ip}` });
    s.push(makeRequest(sender, target.ip));
    s.push({ kind: "TARGET_RECEIVES", title: `${target.name} receives broadcast ARP request and recognizes ${target.ip}` });
    s.push(makeReply(target, sender));
    s.push({ kind: "CACHE_UPDATE", title: `${sender.name} updates ARP cache: ${target.ip} -> ${target.mac}` });
    s.push({ kind: "CACHE_HIT", title: `Second send: ARP cache hit -> no broadcast needed` });
    return s;
  }, [sender, target]);

  const [anim, setAnim] = useState(null);
  const rafRef = useRef(null);
  const lastRef = useRef(0);

  function pushLog(line) {
    setEventLog((prev) => [{ t: now(), line }, ...prev].slice(0, 200));
  }

  function resetAll() {
    setAuto(false);
    setStep(0);
    setSelectedFrame(null);
    setLayerTab("both");
    setEventLog([]);
    setArpCaches(initialCaches);
    setAnim(null);
  }

  function startAnim(fromId, toId, mode, frameObj) {
    const from = nodes[fromId];

    if (mode === "broadcast") {
      const dsts = ["PC1", "PC2", "PC3", "PC4"].filter((id) => id !== fromId);
      const segments = dsts.map((id) => ({ to: nodes[id] }));
      setAnim({ type: "broadcast", from, segments, t: 0, frameObj });
      return;
    }

    const to = nodes[toId];
    setAnim({ type: "unicast", from, to, t: 0, frameObj });
  }

  function stopAnim() {
    setAnim(null);
  }

  // Animate
  useEffect(() => {
    if (!anim) return;
    const durationMs = 1200; // slightly slower to make pause visible

    function tick(ts) {
      if (!lastRef.current) lastRef.current = ts;
      const dt = ts - lastRef.current;
      lastRef.current = ts;

      setAnim((a) => {
        if (!a) return a;
        return { ...a, t: clamp(a.t + dt / durationMs, 0, 1) };
      });

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastRef.current = 0;
    };
  }, [anim]);

  // Auto play
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      setStep((s) => Math.min(s + 1, script.length - 1));
    }, 1350);
    return () => clearInterval(id);
  }, [auto, script.length]);

  // Step effects
  useEffect(() => {
    const cur = script[step];
    if (!cur) return;
    stopAnim();

    if (cur.kind === "START") {
      pushLog(cur.title);
      pushLog("ARP caches are empty at the start.");
    }

    if (cur.kind === "CACHE_CHECK") {
      const has = Boolean(arpCaches[senderId]?.[target.ip]);
      pushLog(`${sender.name} ARP cache lookup: ${target.ip} -> ${has ? arpCaches[senderId][target.ip] : "(missing)"}`);
    }

    if (cur.kind === "CACHE_MISS") pushLog("No entry found, so the host must resolve the target MAC using ARP.");

    if (cur.kind === "ARP_REQUEST") {
      setSelectedFrame(cur.frame);
      pushLog(cur.title);
      pushLog("Broadcast frame: everyone receives it, only the owner of TPA replies.");
      startAnim(senderId, null, "broadcast", cur.frame);
    }

    if (cur.kind === "TARGET_RECEIVES") pushLog(cur.title);

    if (cur.kind === "ARP_REPLY") {
      setSelectedFrame(cur.frame);
      pushLog(cur.title);
      pushLog("Unicast frame: sent only back to the requester MAC.");
      startAnim(targetId, senderId, "unicast", cur.frame);
    }

    if (cur.kind === "CACHE_UPDATE") {
      pushLog(cur.title);
      setArpCaches((prev) => ({
        ...prev,
        [senderId]: { ...prev[senderId], [target.ip]: target.mac },
        [targetId]: { ...prev[targetId], [sender.ip]: sender.mac }
      }));
    }

    if (cur.kind === "CACHE_HIT") {
      pushLog(cur.title);
      pushLog(`${sender.name} can now send IPv4 frames using dst MAC ${target.mac}. (IPv4 not simulated.)`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const stepLabel = `${step + 1} / ${script.length}`;

  const frameDetails = useMemo(() => (selectedFrame ? formatFrame(selectedFrame) : null), [selectedFrame]);

  // UI helpers
  const svgW = 1050;
  const svgH = 650;

  function nodeColor(type) {
    return type === "switch" ? "fill-white/10" : "fill-white/10";
  }

  function Node({ n }) {
    const isKey = n.id === senderId || n.id === targetId;
    const dims = n.type === "switch" ? { w: 260, h: 104, rx: 26 } : { w: 170, h: 82, rx: 18 };

    return (
      <g>
        <rect
          x={n.x - dims.w / 2}
          y={n.y - dims.h / 2}
          width={dims.w}
          height={dims.h}
          rx={dims.rx}
          className={`stroke-white/20 ${nodeColor(n.type)}`}
        />
        <text x={n.x} y={n.y - 14} textAnchor="middle" className="fill-white text-[14px] font-semibold">
          {n.name}
        </text>
        <text x={n.x} y={n.y + 10} textAnchor="middle" className="fill-white/80 text-[12px]">
          {n.ip ? n.ip : `MAC: ${n.mac}`}
        </text>
        {n.ip ? (
          <text x={n.x} y={n.y + 30} textAnchor="middle" className="fill-white/70 text-[11px]">
            {n.mac}
          </text>
        ) : null}

        {isKey ? (
          <rect
            x={n.x - dims.w / 2 - 6}
            y={n.y - dims.h / 2 - 6}
            width={dims.w + 12}
            height={dims.h + 12}
            rx={dims.rx + 6}
            className="stroke-white/40 fill-transparent"
          />
        ) : null}
      </g>
    );
  }

  function Link({ a, b }) {
    const A = nodes[a];
    const B = nodes[b];
    return <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} className="stroke-white/20" strokeWidth={3} />;
  }

  function progressWithPause(t, split, pause) {
    const pauseStart = split;
    const pauseEnd = split + pause;

    if (t < pauseStart) return { leg: 1, u: t / split };
    if (t < pauseEnd) return { leg: 0, u: 1 };

    const rem = 1 - pauseEnd;
    const u2 = rem <= 0 ? 1 : (t - pauseEnd) / rem;
    return { leg: 2, u: clamp(u2, 0, 1) };
  }

  function arpColor(frameObj) {
    const op = frameObj?.arp?.opcode;
    // Request/broadcast = yellow, Reply/unicast = green
    if (op === 1) return { stroke: "stroke-yellow-400/70", fill: "fill-yellow-300" };
    if (op === 2) return { stroke: "stroke-emerald-400/70", fill: "fill-emerald-300" };
    return { stroke: "stroke-white/40", fill: "fill-white" };
  }

  function PacketPath() {
    if (!anim) return null;
    const sw = nodes["SW1"];
    const col = arpColor(anim.frameObj);

    const line = (A, B, key) => (
      <line
        key={key}
        x1={A.x}
        y1={A.y}
        x2={B.x}
        y2={B.y}
        className={col.stroke}
        strokeWidth={8}
        strokeLinecap="round"
      />
    );

    if (anim.type === "broadcast") {
      return (
        <g>
          {line(anim.from, sw, "fs")}
          {anim.segments.map((seg, i) => line(sw, seg.to, `s-${i}`))}
        </g>
      );
    }

    return (
      <g>
        {line(anim.from, sw, "u1")}
        {line(sw, anim.to, "u2")}
      </g>
    );
  }

  function PacketDot() {
    if (!anim) return null;

    const sw = nodes["SW1"];
    const col = arpColor(anim.frameObj);

    // Broadcast: sender -> switch (pause) -> all PCs
    if (anim.type === "broadcast") {
      const senderN = anim.from;
      const split = 0.38;
      const pause = 0.18;
      const p = progressWithPause(anim.t, split, pause);

      if (p.leg === 1) {
        return <circle cx={lerp(senderN.x, sw.x, p.u)} cy={lerp(senderN.y, sw.y, p.u)} r={8} className={col.fill} />;
      }

      if (p.leg === 0) {
        return <circle cx={sw.x} cy={sw.y} r={9} className={col.fill} />;
      }

      return (
        <g>
          {anim.segments.map((seg, idx) => (
            <circle
              key={idx}
              cx={lerp(sw.x, seg.to.x, p.u)}
              cy={lerp(sw.y, seg.to.y, p.u)}
              r={8}
              className={col.fill}
            />
          ))}
        </g>
      );
    }

    // Unicast: from -> switch (pause) -> to
    const from = anim.from;
    const to = anim.to;
    const split = 0.5;
    const pause = 0.18;
    const p = progressWithPause(anim.t, split, pause);

    if (p.leg === 1) {
      return <circle cx={lerp(from.x, sw.x, p.u)} cy={lerp(from.y, sw.y, p.u)} r={8} className={col.fill} />;
    }

    if (p.leg === 0) {
      return <circle cx={sw.x} cy={sw.y} r={9} className={col.fill} />;
    }

    return <circle cx={lerp(sw.x, to.x, p.u)} cy={lerp(sw.y, to.y, p.u)} r={8} className={col.fill} />;
  }

  const deviceList = useMemo(() => {
    const ids = ["PC1", "PC2", "PC3", "PC4", "SW1"];
    return ids.map((id) => nodes[id]);
  }, [nodes]);

  const currentTitle = script[step]?.title ?? "";

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 text-white">
      <div className="mx-auto max-w-[1400px] p-4">
        <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xl font-semibold">ARP Simulator</div>
              <div className="mt-1 text-sm text-white/70">Broadcast (yellow) ARP Request, Unicast (green) ARP Reply, with switch pause.</div>
            </div>
            <div className="flex items-center gap-2">
              {pill(`Step ${stepLabel}`)}
              {pill(auto ? "Auto: ON" : "Auto: OFF")}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={resetAll} className="rounded-xl bg-red-500/90 px-4 py-2 text-sm font-semibold shadow hover:bg-red-500">
              Reset
            </button>
            <button
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold shadow hover:bg-white/15"
            >
              Back
            </button>
            <button
              onClick={() => setStep((s) => Math.min(script.length - 1, s + 1))}
              className="rounded-xl bg-emerald-500/90 px-4 py-2 text-sm font-semibold shadow hover:bg-emerald-500"
            >
              Next →
            </button>
            <button
              onClick={() => setAuto((v) => !v)}
              className="rounded-xl bg-indigo-500/90 px-4 py-2 text-sm font-semibold shadow hover:bg-indigo-500"
            >
              Auto Play
            </button>

            <div className="ml-auto flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <div className="text-sm text-white/80">Zoom: {Math.round(zoom * 100)}%</div>
              <input
                type="range"
                min={0.45}
                max={1.2}
                step={0.01}
                value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                className="w-44"
              />
            </div>
          </div>

          <div className="text-sm text-white/80">
            <span className="text-white/60">Current:</span> {currentTitle}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-3 shadow-sm">
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/40">
              <div className="h-[540px] w-full">
                <svg viewBox={`0 0 ${svgW} ${svgH}`} className="h-full w-full" style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}>
                  <defs>
                    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                      <path d="M 40 0 L 0 0 0 40" fill="none" className="stroke-white/5" strokeWidth="1" />
                    </pattern>
                  </defs>
                  <rect width={svgW} height={svgH} fill="url(#grid)" />

                  {links.map((l, i) => (
                    <Link key={i} a={l.a} b={l.b} />
                  ))}

                  <PacketPath />
                  <PacketDot />

                  {Object.values(nodes).map((n) => (
                    <Node key={n.id} n={n} />
                  ))}
                </svg>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <PanelCard title="ARP Cache (sender / target)">
                <div className="space-y-2 text-sm text-white/80">
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                    <div className="font-semibold text-white">{sender.name}</div>
                    <div className="mt-1 font-mono text-xs whitespace-pre-wrap">
                      {Object.keys(arpCaches[senderId]).length === 0
                        ? "(empty)"
                        : Object.entries(arpCaches[senderId])
                            .map(([ip, mac]) => `${ip} -> ${mac}`)
                            .join("\n")}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                    <div className="font-semibold text-white">{target.name}</div>
                    <div className="mt-1 font-mono text-xs whitespace-pre-wrap">
                      {Object.keys(arpCaches[targetId]).length === 0
                        ? "(empty)"
                        : Object.entries(arpCaches[targetId])
                            .map(([ip, mac]) => `${ip} -> ${mac}`)
                            .join("\n")}
                    </div>
                  </div>
                </div>
              </PanelCard>

              <PanelCard title="Selected frame details (Ethernet vs ARP)">
                {!frameDetails ? (
                  <div className="text-sm text-white/70">Advance to the ARP Request/Reply steps to see full headers.</div>
                ) : (
                  <div className="grid grid-cols-1 gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => setLayerTab("both")}
                        className={`rounded-xl px-3 py-1 text-xs font-semibold ${layerTab === "both" ? "bg-white/15" : "bg-white/5 hover:bg-white/10"}`}
                      >
                        Ethernet + ARP
                      </button>
                      <button
                        onClick={() => setLayerTab("ethernet")}
                        className={`rounded-xl px-3 py-1 text-xs font-semibold ${layerTab === "ethernet" ? "bg-white/15" : "bg-white/5 hover:bg-white/10"}`}
                      >
                        Ethernet (L2)
                      </button>
                      <button
                        onClick={() => setLayerTab("arp")}
                        className={`rounded-xl px-3 py-1 text-xs font-semibold ${layerTab === "arp" ? "bg-white/15" : "bg-white/5 hover:bg-white/10"}`}
                      >
                        ARP ("L2.5")
                      </button>
                    </div>

                    {(layerTab === "both" || layerTab === "ethernet") && (
                      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                        <div className="text-xs font-semibold text-white/80">Ethernet II (Layer 2)</div>
                        <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-white/80">{frameDetails.ethernet}</pre>
                      </div>
                    )}

                    {(layerTab === "both" || layerTab === "arp") && (
                      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                        <div className="text-xs font-semibold text-white/80">ARP (between L2/L3)</div>
                        <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-white/80">{frameDetails.arp}</pre>
                      </div>
                    )}
                  </div>
                )}
              </PanelCard>
            </div>
          </div>

          <div className="space-y-4">
            <PanelCard title="Network devices">
              <div className="space-y-3">
                {deviceList.map((d) => (
                  <div key={d.id} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">{d.name}</div>
                      {d.id === senderId ? pill("Sender") : d.id === targetId ? pill("Target") : null}
                    </div>
                    <div className="mt-1 text-sm text-white/80">
                      {d.ip ? (
                        <>
                          <div>
                            IP: <span className="font-mono">{d.ip}</span>
                          </div>
                          <div>
                            MAC: <span className="font-mono">{d.mac}</span>
                          </div>
                        </>
                      ) : (
                        <div>
                          MAC: <span className="font-mono">{d.mac}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </PanelCard>

            <PanelCard title="Event log">
              <div className="max-h-[290px] overflow-auto rounded-xl border border-white/10 bg-slate-950/40 p-2">
                {eventLog.length === 0 ? (
                  <div className="p-2 text-sm text-white/60">(no events yet) — press Next</div>
                ) : (
                  <div className="space-y-2">
                    {eventLog.map((e, idx) => (
                      <div key={idx} className="rounded-xl border border-white/10 bg-white/5 p-2">
                        <div className="text-xs text-white/60">{e.t}</div>
                        <div className="text-sm text-white/80">{e.line}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-2 text-xs text-white/60">Tip: Steps 4 and 6 show the raw Ethernet + ARP fields.</div>
            </PanelCard>
          </div>
        </div>
      </div>
    </div>
  );
}
