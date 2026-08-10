import { useAppStore, type TypingMode } from '../store';

export default function ModeToggle() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);

  const button = (value: TypingMode, label: string, hint: string) => (
    <button
      className={mode === value ? 'mode-active' : ''}
      aria-pressed={mode === value}
      title={hint}
      onClick={() => setMode(value)}
    >
      {label}
    </button>
  );

  return (
    <div className="mode-toggle" role="group" aria-label="Typing mode">
      {button('live', 'Live', 'Every character is typed on the PC as you produce it — use with the keyboard mic for dictation')}
      {button('compose', 'Compose', 'Write a block of text, then send it all at once')}
    </div>
  );
}
