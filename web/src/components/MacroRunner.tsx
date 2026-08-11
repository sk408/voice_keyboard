import { useEffect, useMemo, useRef, useState } from 'react';
import { encodeSegment, macroFields, tokenizeMacro } from '../macros';
import type { Macro } from '../macroStorage';
import { useAppStore } from '../store';

interface Props {
  macro: Macro;
  /** Back to the macro list. */
  onExit(): void;
}

type Phase = 'fields' | 'typing' | 'done';

/**
 * Macro runner. Phase 1: ask for each fill-in field, one at a time.
 * Phase 2: type the encoded macro through the store's paced send queue,
 * one segment at a time, with progress and a Stop button.
 */
export default function MacroRunner({ macro, onExit }: Props) {
  const sendSegment = useAppStore((s) => s.sendSegment);
  const fields = useMemo(() => macroFields(macro.template), [macro.template]);

  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldIndex, setFieldIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>(fields.length === 0 ? 'typing' : 'fields');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [message, setMessage] = useState<string | null>(null);

  const abortRef = useRef(false);
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current = true;
    };
  }, []);

  const run = async (vals: Record<string, string>) => {
    setPhase('typing');
    setMessage(null);
    const segments = tokenizeMacro(macro.template);
    const fieldTotal = segments.filter((s) => s.type === 'field').length;
    let fieldDone = 0;
    setProgress({ done: 0, total: fieldTotal });

    const stopWith = (msg: string) => {
      if (!mountedRef.current) return;
      setMessage(msg);
      setPhase('done');
    };

    for (const segment of segments) {
      if (abortRef.current) {
        stopWith('Stopped.');
        return;
      }
      if (useAppStore.getState().connection !== 'connected') {
        stopWith('Stopped — dongle disconnected');
        return;
      }
      const ok = await sendSegment(encodeSegment(segment, vals));
      if (!mountedRef.current) return;
      if (segment.type === 'field') {
        fieldDone++;
        setProgress({ done: fieldDone, total: fieldTotal });
      }
      if (!ok) {
        stopWith(
          useAppStore.getState().connection !== 'connected'
            ? 'Stopped — dongle disconnected'
            : 'Stopped — send failed',
        );
        return;
      }
    }
    stopWith('Done.');
  };

  // Macros without fields start typing immediately (guard against
  // StrictMode's double effect).
  useEffect(() => {
    if (fields.length === 0 && !startedRef.current) {
      startedRef.current = true;
      void run({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'fields') {
    const name = fields[fieldIndex];
    const last = fieldIndex === fields.length - 1;
    const advance = () => {
      if (last) {
        void run(values);
      } else {
        setFieldIndex(fieldIndex + 1);
      }
    };
    return (
      <div className="macro-runner">
        <span className="badge">
          Field {fieldIndex + 1} of {fields.length}
        </span>
        <label className="macro-field-label" htmlFor="macro-field-input">
          {name}
        </label>
        <textarea
          id="macro-field-input"
          className="type-area"
          rows={4}
          autoFocus
          placeholder={`Dictate or type: ${name}`}
          value={values[name] ?? ''}
          onChange={(e) => setValues({ ...values, [name]: e.target.value })}
          onKeyDown={(e) => {
            // Enter advances (Shift+Enter inserts a newline).
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              advance();
            }
          }}
        />
        <div className="panel-actions">
          <button onClick={advance}>{last ? 'Start typing' : 'Next'}</button>
          <button
            className="secondary"
            onClick={() => {
              abortRef.current = true;
              onExit();
            }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="macro-runner">
      <div className="macro-progress" role="status">
        {phase === 'typing'
          ? progress.total > 0
            ? `Typing… ${progress.done}/${progress.total} fields`
            : 'Typing…'
          : message}
      </div>
      {phase === 'typing' ? (
        <button
          className="secondary"
          onClick={() => {
            abortRef.current = true;
          }}
        >
          Stop
        </button>
      ) : (
        <button onClick={onExit}>Back</button>
      )}
    </div>
  );
}
