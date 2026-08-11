import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { MOUSE_BUTTON_LEFT, MOUSE_BUTTON_MIDDLE, MOUSE_BUTTON_RIGHT } from '../protocol';
import { screenFractionToNorm } from '../calibration';

/**
 * Mouse tab: a full-width trackpad plus on-screen buttons and a scroll strip.
 *
 * v4 gesture model:
 * - one-finger drag  → the configured one-finger mode:
 *     · absolute (default): the pad maps to the whole screen through the
 *       calibration map; the cursor tracks the finger (0x91 packets)
 *     · relative: classic deltas (0x90 dx/dy)
 * - two-finger drag  → classic relative deltas, in either mode
 * - tap              → left click (in absolute mode, at the tapped spot)
 * - two-finger tap   → right click
 * - scroll strip     → vertical drag = wheel (natural direction: up = up)
 * - buttons below    → hold-to-press left/middle/right; the held set rides in
 *                      every packet (both 0x90 and 0x91), so hold Left while
 *                      dragging for drag-select in either mode
 *
 * Packets are flushed at ~50 pkt/s. Pointer events with pointer capture
 * cover both touch and mouse input.
 */

/** CSS px → HID counts for relative drags. */
const SENSITIVITY = 2;
/** Max pointer travel (px) for a gesture to still count as a tap. */
const TAP_SLOP_PX = 12;
/** Max press duration (ms) for a tap. */
const TAP_TIME_MS = 300;
/** Movement flush period: 20 ms = 50 packets/s max. */
const FLUSH_MS = 20;

export default function MousePad() {
  const connected = useAppStore((s) => s.connection === 'connected');
  const sendMouse = useAppStore((s) => s.sendMouse);
  const sendAbsolute = useAppStore((s) => s.sendAbsolute);
  const oneFinger = useAppStore((s) => s.defaultOneFinger);
  const calibration = useAppStore((s) => s.calibration);

  const sendMouseRef = useRef(sendMouse);
  sendMouseRef.current = sendMouse;
  const sendAbsRef = useRef(sendAbsolute);
  sendAbsRef.current = sendAbsolute;
  const modeRef = useRef(oneFinger);
  modeRef.current = oneFinger;
  const calRef = useRef(calibration);
  calRef.current = calibration;

  const padRef = useRef<HTMLDivElement>(null);
  /** Active pad pointers: id → last position (client coords). */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** Pointer whose deltas drive relative moves (first finger down). */
  const anchorId = useRef<number | null>(null);
  /** Gesture bookkeeping for tap detection. */
  const gesture = useRef({ travel: 0, maxPointers: 0, downAt: 0 });
  /** Accumulated relative deltas awaiting the next flush. */
  const pending = useRef({ dx: 0, dy: 0, wheel: 0 });
  /** Latest absolute position awaiting the next flush (null = nothing new). */
  const pendingAbs = useRef<{ x: number; y: number } | null>(null);
  /** Last absolute position sent from this pad (normalized coords). */
  const lastAbs = useRef<{ x: number; y: number } | null>(null);
  /** Buttons held via the on-screen buttons (included in every packet). */
  const heldButtons = useRef(0);
  const flushTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const timer = flushTimer.current;
    return () => window.clearInterval(timer);
  }, []);

  const flush = () => {
    const p = pending.current;
    if (p.dx !== 0 || p.dy !== 0 || p.wheel !== 0) {
      sendMouseRef.current(heldButtons.current, p.dx, p.dy, p.wheel);
      p.dx = 0;
      p.dy = 0;
      p.wheel = 0;
    }
    const a = pendingAbs.current;
    if (a) {
      pendingAbs.current = null;
      lastAbs.current = a;
      sendAbsRef.current(heldButtons.current, a.x, a.y);
    }
  };

  const startFlush = () => {
    if (flushTimer.current === undefined) {
      flushTimer.current = window.setInterval(flush, FLUSH_MS);
    }
  };

  const stopFlush = () => {
    window.clearInterval(flushTimer.current);
    flushTimer.current = undefined;
    flush(); // don't drop the tail of a gesture
  };

  /** Client coords → pad fraction (0..1, clamped), or null when unmeasurable. */
  const padFraction = (pos: { x: number; y: number }) => {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      fx: Math.min(1, Math.max(0, (pos.x - rect.left) / rect.width)),
      fy: Math.min(1, Math.max(0, (pos.y - rect.top) / rect.height)),
    };
  };

  const queueAbsolute = (pos: { x: number; y: number }) => {
    const f = padFraction(pos);
    if (!f) return;
    pendingAbs.current = screenFractionToNorm(calRef.current, f.fx, f.fy);
  };

  /** Tap → click. In absolute mode the click lands at the tapped spot. */
  const tapClick = (button: number, pos: { x: number; y: number }) => {
    if (modeRef.current === 'absolute') {
      const f = padFraction(pos);
      if (f) {
        const { x, y } = screenFractionToNorm(calRef.current, f.fx, f.fy);
        lastAbs.current = { x, y };
        sendAbsRef.current(button, x, y);
        window.setTimeout(() => sendAbsRef.current(0, x, y), 60);
        return;
      }
    }
    sendMouseRef.current(button, 0, 0, 0);
    window.setTimeout(() => sendMouseRef.current(0, 0, 0, 0), 60);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!connected) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 1) {
      anchorId.current = e.pointerId;
      g.travel = 0;
      g.maxPointers = 1;
      g.downAt = performance.now();
      // Absolute mode: touch = jump to the finger.
      if (modeRef.current === 'absolute') {
        queueAbsolute({ x: e.clientX, y: e.clientY });
      }
    } else {
      g.maxPointers = Math.max(g.maxPointers, pointers.current.size);
    }
    startFlush();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const g = gesture.current;
    g.travel += Math.abs(dx) + Math.abs(dy);

    if (pointers.current.size >= 2 || modeRef.current === 'relative') {
      // Relative path: two fingers always mean classic deltas, in either
      // one-finger mode. Only the anchor pointer drives movement.
      if (e.pointerId === anchorId.current) {
        const p = pending.current;
        p.dx += dx * SENSITIVITY;
        p.dy += dy * SENSITIVITY;
      }
    } else {
      queueAbsolute({ x: e.clientX, y: e.clientY });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const pos = pointers.current.get(e.pointerId);
    const had = pointers.current.delete(e.pointerId);
    if (!had || !pos) return;
    if (e.pointerId === anchorId.current) {
      // Re-anchor to a remaining pointer so relative drags don't jump.
      const next = pointers.current.keys().next();
      anchorId.current = next.done ? null : next.value;
    }
    if (pointers.current.size > 0) return;

    stopFlush();
    const g = gesture.current;
    const isTap = g.travel < TAP_SLOP_PX && performance.now() - g.downAt < TAP_TIME_MS;
    if (isTap && connected) {
      tapClick(g.maxPointers >= 2 ? MOUSE_BUTTON_RIGHT : MOUSE_BUTTON_LEFT, pos);
    }
    g.travel = 0;
    g.maxPointers = 0;
  };

  /* Dedicated scroll strip: vertical drag → wheel (natural direction). */
  const stripPointers = useRef(new Map<number, number>());

  const onStripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!connected) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    stripPointers.current.set(e.pointerId, e.clientY);
    startFlush();
  };

  const onStripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = stripPointers.current.get(e.pointerId);
    if (prev === undefined) return;
    stripPointers.current.set(e.pointerId, e.clientY);
    // Drag up (dy < 0) scrolls up.
    pending.current.wheel += -(e.clientY - prev);
  };

  const onStripUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!stripPointers.current.delete(e.pointerId)) return;
    if (stripPointers.current.size === 0 && pointers.current.size === 0) stopFlush();
  };

  const pressButton = (bit: number, down: boolean) => {
    if (!connected) return;
    heldButtons.current = down ? heldButtons.current | bit : heldButtons.current & ~bit;
    // Button state must ride in the same report type as the movement: a
    // digitizer (0x91) drag-select only sees buttons carried by 0x91 packets.
    const abs = lastAbs.current ?? useAppStore.getState().lastAbsolute;
    if (modeRef.current === 'absolute' && abs) {
      lastAbs.current = abs;
      sendAbsRef.current(heldButtons.current, abs.x, abs.y);
    } else {
      sendMouseRef.current(heldButtons.current, 0, 0, 0);
    }
  };

  const mouseButton = (label: string, bit: number) => (
    <button
      className="mouse-btn"
      disabled={!connected}
      onPointerDown={(e) => {
        e.preventDefault();
        pressButton(bit, true);
      }}
      onPointerUp={() => pressButton(bit, false)}
      onPointerCancel={() => pressButton(bit, false)}
      onPointerLeave={() => pressButton(bit, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  const hint = !connected
    ? 'Connect to a dongle to use the trackpad'
    : oneFinger === 'absolute'
      ? 'one finger = point at the screen · two fingers = classic drag · tap = left click · two-finger tap = right click'
      : 'drag = move · tap = left click · two-finger tap = right click';

  return (
    <div className="mouse-panel">
      <div className="mouse-mode-row">
        <span className="badge">
          1-finger: {oneFinger === 'absolute' ? 'absolute pointer' : 'classic relative'}
        </span>
        <span className="macro-hint">change in Settings</span>
      </div>
      <div className="mouse-row">
        <div
          ref={padRef}
          className={`trackpad${connected ? '' : ' trackpad-disabled'}`}
          role="application"
          aria-label="Trackpad"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="trackpad-hint">{hint}</span>
        </div>
        <div
          className={`scroll-strip${connected ? '' : ' trackpad-disabled'}`}
          role="application"
          aria-label="Scroll strip"
          onPointerDown={onStripDown}
          onPointerMove={onStripMove}
          onPointerUp={onStripUp}
          onPointerCancel={onStripUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="trackpad-hint scroll-strip-hint">scroll</span>
        </div>
      </div>
      <div className="mouse-buttons">
        {mouseButton('Left', MOUSE_BUTTON_LEFT)}
        {mouseButton('Middle', MOUSE_BUTTON_MIDDLE)}
        {mouseButton('Right', MOUSE_BUTTON_RIGHT)}
      </div>
    </div>
  );
}
