import { useMemo, useState } from "react";
import { TaskInput } from "../lib/api";
import { parseQuickAdd } from "../lib/quickadd";
import { usePlanner } from "../lib/planner";

interface Props {
  placeholder: string;
  /** called with the parsed task; dates default to today unless only a deadline was given */
  onAdd: (input: TaskInput) => void;
  className?: string;
}

/** A one-line task box that understands "tomorrow 3pm #work !high" and shows what it read. */
export function QuickAddInput({ placeholder, onAdd, className }: Props) {
  const { today, categories } = usePlanner();
  const [text, setText] = useState("");
  const parsed = useMemo(() => (text.trim() ? parseQuickAdd(text, today, categories) : null), [text, today, categories]);

  return (
    <form
      className={`quick-add ${className ?? ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!parsed) return;
        const input = { ...parsed.input };
        if (!input.date && !input.deadline) input.date = today;
        setText("");
        onAdd(input);
      }}
    >
      <input
        className="input"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={placeholder}
        title="Try: Dentist tomorrow 3pm for 45m #health !high +prep, or Bins every monday"
      />
      {parsed && parsed.chips.length > 0 && (
        <div className="qa-chips" aria-live="polite">
          <span className="qa-title">{parsed.input.title}</span>
          {parsed.chips.map((c) => <span key={c} className="pill accent">{c}</span>)}
        </div>
      )}
    </form>
  );
}
