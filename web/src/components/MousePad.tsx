import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { MOUSE_BUTTON_LEFT, MOUSE_BUTTON_MIDDLE, MOUSE_BUTTON_RIGHT } from '../protocol';

/**
 * Mouse tab: a full-width trackpad plus on-screen buttons.
 *
 * - one-finger drag  → pointer movement (0x90 dx/dy, flushed at ~50 pkt/s)
 * - tap              → left click
 * - two-finger tap   → right click
 * - two-finger drag  → scroll wheel (natural direction: fingers up = up)
 * - buttons below    → hold-to-press left/middle/right (combine with a
 *                      trackpad drag for drag-select)
 *
 * Pointer events with pointer capture cover both touch and mouse input.
 */

/** CSS px → HID counts for one-finger drags. */
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

  const sendRef = useRef(sendMouse);
  sendRef.current = sendMouse;

  const padRef = useRef<HTMLDivElement>(null);
  /** Active pointers: id → last position. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** Gesture bookkeeping for tap detection. */
  const gesture = useRef({ travel: 0, maxPointers: 0, downAt: 0 });
  /** Accumulated deltas awaiting the next flush. */
  const pending = useRef({ dx: 0, dy: 0, wheel: 0 });
  /** Buttons held via the on-screen buttons (included in every packet). */
  const heldButtons = useRef(0);
  const flushTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const timer = flushTimer.current;
    return () => window.clearInterval(timer);
  }, []);

  const flush = () => {
    const p = pending.current;
    if (p.dx === 0 && p.dy === 0 && p.wheel === 0) return;
    sendRef.current(heldButtons.current, p.dx, p.dy, p.wheel);
    p.dx = 0;
    p.dy = 0;
    p.wheel = 0;
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

  const click = (button: number) => {
    sendRef.current(button, 0, 0, 0);
    window.setTimeout(() => sendRef.current(0, 0, 0, 0), 60);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!connected) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 1) {
      g.travel = 0;
      g.maxPointers = 1;
      g.downAt = performance.now();
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

    const p = pending.current;
    if (pointers.current.size >= 2) {
      // Two-finger drag = wheel; fingers up (dy < 0) scrolls up.
      p.wheel += -dy;
    } else {
      p.dx += dx * SENSITIVITY;
      p.dy += dy * SENSITIVITY;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const had = pointers.current.delete(e.pointerId);
    if (!had || pointers.current.size > 0) return;

    stopFlush();
    const g = gesture.current;
    const isTap = g.travel < TAP_SLOP_PX && performance.now() - g.downAt < TAP_TIME_MS;
    if (isTap && connected) {
      click(g.maxPointers >= 2 ? MOUSE_BUTTON_RIGHT : MOUSE_BUTTON_LEFT);
    }
    g.travel = 0;
    g.maxPointers = 0;
  };

  const pressButton = (bit: number, down: boolean) => {
    if (!connected) return;
    heldButtons.current = down ? heldButtons.current | bit : heldButtons.current & ~bit;
    sendRef.current(heldButtons.current, 0, 0, 0);
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

  return (
    <div className="mouse-panel">
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
        <span className="trackpad-hint">
          {connected
            ? 'drag = move · tap = left click · two-finger tap = right click · two-finger drag = scroll'
            : 'Connect to a dongle to use the trackpad'}
        </span>
      </div>
      <div className="mouse-buttons">
        {mouseButton('Left', MOUSE_BUTTON_LEFT)}
        {mouseButton('Middle', MOUSE_BUTTON_MIDDLE)}
        {mouseButton('Right', MOUSE_BUTTON_RIGHT)}
      </div>
    </div>
  );
}
