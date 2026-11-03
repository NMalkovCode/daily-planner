// Quick add in plain words: "Dentist tomorrow 3pm for 45m #health !high +prep".
//
//   dates     today, tomorrow, fri, friday, in 3 days, in 2 weeks, next week,
//             12 nov, nov 12, 12/11 (day/month), 2026-11-12
//   time      3pm, 9:30am, 15:00, at 9
//   duration  for 45m, for 1.5h, for 2 hours
//   deadline  due fri, by 12 nov  (sets a deadline instead of the date)
//   repeat    daily, weekly, every day, every weekday, every monday, every month
//   priority  !high !h !!!, !low !l
//   category  #work (matches the start of a category name)
//   prep      +prep  ("Task requires preparation")
//
// Everything that isn't recognised stays in the title.

import type { Category, Priority, TaskInput } from "./api";
import { addDays, formatDate, parseDate } from "./dates";
import { duration as fmtDuration, relativeDay, shortDate } from "./format";
import { describeRule, isoWeekday, parseRule } from "./repeat";

export interface QuickAdd {
  input: TaskInput;
  /** what was understood, for the preview under the input */
  chips: string[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_RE = "mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
const MONTH_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

// One date expression; each alternative has its own capture groups.
const DATE =
  `(today|tonight|tomorrow|tmrw?|next week)` + // 1
  `|in (\\d+) (days?|weeks?)` + // 2, 3
  `|(?:on )?(${DAY_RE})` + // 4
  `|(\\d{1,2})(?:st|nd|rd|th)? (${MONTH_RE})` + // 5, 6
  `|(${MONTH_RE}) (\\d{1,2})(?:st|nd|rd|th)?` + // 7, 8
  `|(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?` + // 9, 10, 11
  `|(\\d{4}-\\d{2}-\\d{2})`; // 12

const valid = (y: number, m: number, d: number) => {
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d ? formatDate(date) : null;
};

/** The next `month/day` on or after today. */
function upcoming(today: string, month: number, day: number): string | null {
  const year = parseDate(today).getFullYear();
  const d = valid(year, month, day);
  return d && d < today ? valid(year + 1, month, day) : d;
}

/** The next given weekday after today (a week ahead if it's today). */
function nextWeekday(today: string, iso: number): string {
  const diff = (iso - isoWeekday(today) + 7) % 7 || 7;
  return addDays(today, diff);
}

function resolveDate(m: RegExpExecArray, offset: number, today: string): string | null {
  const g = (i: number) => m[offset + i]?.toLowerCase();
  if (g(1)) {
    const w = g(1);
    if (w === "today" || w === "tonight") return today;
    if (w === "next week") return nextWeekday(today, 1);
    return addDays(today, 1);
  }
  if (g(2)) return addDays(today, Number(g(2)) * (g(3).startsWith("week") ? 7 : 1));
  if (g(4)) return nextWeekday(today, DAYS.indexOf(g(4).slice(0, 3)) + 1);
  if (g(5)) return upcoming(today, MONTHS.indexOf(g(6).slice(0, 3)) + 1, Number(g(5)));
  if (g(7)) return upcoming(today, MONTHS.indexOf(g(7).slice(0, 3)) + 1, Number(g(8)));
  if (g(9)) {
    if (!g(11)) return upcoming(today, Number(g(10)), Number(g(9)));
    const y = Number(g(11));
    return valid(y < 100 ? 2000 + y : y, Number(g(10)), Number(g(9)));
  }
  if (g(12)) return valid(...(g(12).split("-").map(Number) as [number, number, number]));
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function parseQuickAdd(text: string, today: string, categories: Category[] = []): QuickAdd {
  let rest = ` ${text} `;
  const input: TaskInput = { title: "" };
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean | void) => {
    const m = re.exec(rest);
    if (m && fn(m) !== false) rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
  };
  const word = (src: string) => new RegExp(`(?<=\\s)(?:${src})(?=[\\s,.!?]|$)`, "i");

  take(/(?<=\s)#([\p{L}\d_-]+)/iu, (m) => {
    const cat = categories.find((c) => c.name.toLowerCase().startsWith(m[1].toLowerCase()));
    if (!cat) return false;
    input.categoryId = cat.id;
  });
  take(word("!(high|h|medium|med|m|low|l)|!!!|!!"), (m) => {
    const p = (m[1] ?? (m[0] === "!!!" ? "high" : "medium")).toLowerCase();
    input.priority = (p.startsWith("h") ? "high" : p.startsWith("l") ? "low" : "medium") as Priority;
  });
  take(word("\\+prep"), () => {
    input.requiresPrep = true;
  });

  let repeatDay: number | null = null;
  take(word(`every (day|weekday|week|month|year|${DAY_RE})s?|daily|weekly|monthly|yearly`), (m) => {
    const w = (m[1] ?? m[0]).toLowerCase();
    if (w === "day" || w === "daily") input.recurrenceRule = "daily";
    else if (w === "weekday") input.recurrenceRule = "weekdays";
    else if (w === "week" || w === "weekly") input.recurrenceRule = "weekly";
    else if (w === "month" || w === "monthly") input.recurrenceRule = "monthly";
    else if (w === "year" || w === "yearly") input.recurrenceRule = "yearly";
    else {
      repeatDay = DAYS.indexOf(w.slice(0, 3)) + 1;
      input.recurrenceRule = `weekly:${repeatDay}`;
    }
  });

  take(word("for (\\d+(?:\\.\\d+)?) ?(h|hrs?|hours?|m|mins?|minutes?)"), (m) => {
    const n = Number(m[1]) * (m[2].toLowerCase().startsWith("h") ? 60 : 1);
    if (!(n > 0 && n <= 24 * 60)) return false;
    input.durationMin = Math.round(n);
  });

  take(word(`(?:due|by) (?:${DATE})`), (m) => {
    const d = resolveDate(m, 0, today);
    if (!d) return false;
    input.deadline = d;
  });

  take(word("(?:at )?(\\d{1,2})(?::(\\d{2}))? ?(am|pm)|(?:at )(\\d{1,2})(?::(\\d{2}))?|(\\d{1,2}):(\\d{2})"), (m) => {
    let h: number, min: number;
    if (m[3]) {
      h = Number(m[1]) % 12 + (m[3].toLowerCase() === "pm" ? 12 : 0);
      min = Number(m[2] ?? 0);
    } else if (m[4]) {
      h = Number(m[4]);
      min = Number(m[5] ?? 0);
    } else {
      h = Number(m[6]);
      min = Number(m[7]);
    }
    if (h > 23 || min > 59) return false;
    input.startTime = `${pad(h)}:${pad(min)}`;
  });

  take(word(DATE), (m) => {
    const d = resolveDate(m, 0, today);
    if (!d) return false;
    input.date = d;
  });

  if (!input.date && repeatDay) input.date = nextWeekday(addDays(today, -1), repeatDay);
  if (!input.date && (input.recurrenceRule || input.startTime)) input.date = today;
  if (input.deadline && input.startTime && !input.date) input.date = today;

  input.title = rest.replace(/\s+/g, " ").trim() || text.trim();

  const chips: string[] = [];
  if (input.date) chips.push(relativeDay(today, input.date));
  if (input.startTime) chips.push(input.startTime);
  if (input.durationMin) chips.push(fmtDuration(input.durationMin));
  if (input.deadline) chips.push(`Due ${input.deadline === today ? "today" : shortDate(input.deadline)}`);
  const rule = parseRule(input.recurrenceRule);
  if (rule) chips.push(describeRule(rule, input.date ?? today));
  if (input.priority && input.priority !== "medium") chips.push(input.priority === "high" ? "High priority" : "Low priority");
  if (input.categoryId != null) chips.push(categories.find((c) => c.id === input.categoryId)!.name);
  if (input.requiresPrep) chips.push("Needs preparation");
  return { input, chips };
}
