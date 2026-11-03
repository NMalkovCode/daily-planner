import { useEffect, useRef, useState } from "react";
import { api, Task } from "../lib/api";
import { relativeDay, shortDate } from "../lib/format";
import { usePlanner } from "../lib/planner";
import { Icon } from "./Icon";

/** Ctrl+K: find any task by its title, notes or preparation notes. */
export function SearchDialog({ onClose }: { onClose: () => void }) {
  const { today, openEditor, categoryById } = usePlanner();
  const [text, setText] = useState("");
  const [results, setResults] = useState<Task[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const t = setTimeout(() => {
      api.searchTasks(text).then((r) => {
        setResults(r);
        setActive(0);
      });
    }, 120);
    return () => clearTimeout(t);
  }, [text]);

  const open = (t: Task) => {
    onClose();
    openEditor({ task: t });
  };

  return (
    <div className="backdrop search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal search" role="dialog" aria-label="Search tasks">
        <div className="search-box">
          <Icon name="search" />
          <input
            ref={inputRef}
            placeholder="Search tasks and notes…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") setActive((a) => Math.min(results.length - 1, a + 1));
              else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
              else if (e.key === "Enter" && results[active]) open(results[active]);
              else return;
              e.preventDefault();
            }}
            aria-label="Search tasks"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="search-results">
          {text.trim() && results.length === 0 && <div className="empty">No tasks match “{text.trim()}”.</div>}
          {results.map((t, i) => {
            const cat = categoryById(t.categoryId);
            const when = t.date ? (t.endDate ? `${shortDate(t.date)} – ${shortDate(t.endDate)}` : relativeDay(today, t.date)) : "No date";
            return (
              <button
                key={t.id}
                className={`search-result ${i === active ? "active" : ""} ${t.status === "done" ? "done" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => open(t)}
              >
                {cat ? <i className="dot" style={{ background: cat.colour }} /> : <i className="dot" />}
                <span className="search-title">{t.title}</span>
                {t.status === "done" && <span className="pill">Done</span>}
                {t.parentTaskId != null && <span className="pill">Subtask</span>}
                <span className="search-when">{when}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
