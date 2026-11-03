import { describe, expect, it } from "vitest";
import type { Task } from "./api";
import {
  deadlineItems,
  layoutRow,
  layoutTimed,
  monthWeeks,
  overflow,
  startOfWeek,
  taskItem,
  textOn,
  weekDays,
} from "./calendar";

let nextId = 1;
function task(p: Partial<Task>): Task {
  return {
    id: nextId++, title: "t", notes: "", date: null, endDate: null, startTime: null, durationMin: null,
    deadline: null, priority: "medium", categoryId: null, status: "open", completedAt: null,
    requiresPrep: false, prepNotes: "", prepDaysBefore: 1, prepDone: false, recurrenceRule: null, seriesId: null,
    parentTaskId: null, sortOrder: 0, createdAt: "", updatedAt: "", ...p,
  };
}

describe("weeks", () => {
  it("starts weeks on Monday", () => {
    expect(startOfWeek("2026-11-03")).toBe("2026-11-02"); // Tue -> Mon
    expect(startOfWeek("2026-11-08")).toBe("2026-11-02"); // Sun -> Mon
    expect(startOfWeek("2026-11-08", 0)).toBe("2026-11-08"); // Sunday start
    expect(weekDays("2026-11-03")).toHaveLength(7);
  });

  it("covers the whole month in full weeks", () => {
    const weeks = monthWeeks("2026-11-15");
    expect(weeks[0][0]).toBe("2026-10-26");
    expect(weeks[weeks.length - 1][6]).toBe("2026-12-06");
    expect(weeks).toHaveLength(6);
    expect(monthWeeks("2027-02-01")).toHaveLength(4); // Feb 2027 starts on a Monday
  });
});

describe("layoutRow", () => {
  const week = weekDays("2026-11-02"); // Mon 2 – Sun 8 Nov

  it("draws a 6-day project as one segment spanning 6 columns", () => {
    const p = taskItem(task({ date: "2026-11-02", endDate: "2026-11-07" }));
    const { segments } = layoutRow([p], week);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startCol: 0, span: 6, startsHere: true, endsHere: true });
  });

  it("splits a project across week rows with flat inner edges", () => {
    const p = taskItem(task({ date: "2026-11-05", endDate: "2026-11-10" }));
    const [a] = layoutRow([p], week).segments;
    const [b] = layoutRow([p], weekDays("2026-11-09")).segments;
    expect(a).toMatchObject({ startCol: 3, span: 4, startsHere: true, endsHere: false });
    expect(b).toMatchObject({ startCol: 0, span: 2, startsHere: false, endsHere: true });
  });

  it("stacks overlapping items in lanes, bars above single days", () => {
    const single = taskItem(task({ date: "2026-11-04" }));
    const p1 = taskItem(task({ date: "2026-11-02", endDate: "2026-11-05" }));
    const p2 = taskItem(task({ date: "2026-11-04", endDate: "2026-11-08" }));
    const later = taskItem(task({ date: "2026-11-07" }));
    const { segments, laneCount } = layoutRow([single, p1, p2, later], week);
    const lane = (i: typeof single) => segments.find((s) => s.item === i)!.lane;
    expect(lane(p1)).toBe(0);
    expect(lane(p2)).toBe(1);
    expect(lane(single)).toBe(2);
    expect(lane(later)).toBe(0); // reuses the free space after p1 ends
    expect(laneCount).toBe(3);
  });

  it("skips items outside the row", () => {
    const outside = taskItem(task({ date: "2026-11-10" }));
    expect(layoutRow([outside], week).segments).toHaveLength(0);
  });

  it("collapses overflowing lanes into +N more counts", () => {
    const items = [0, 1, 2, 3].map(() => taskItem(task({ date: "2026-11-03" })));
    const { segments, laneCount } = layoutRow(items, week);
    const { visible, hidden } = overflow(segments, laneCount, 3, 7);
    expect(visible).toHaveLength(2);
    expect(hidden[1]).toBe(2);
    expect(hidden[0]).toBe(0);
  });
});

describe("deadlineItems", () => {
  it("adds a marker only when the deadline is on another day", () => {
    const sameDay = task({ date: "2026-11-05", deadline: "2026-11-05 17:00" });
    const other = task({ date: "2026-11-03", deadline: "2026-11-06" });
    const undated = task({ deadline: "2026-11-07" });
    const items = deadlineItems([sameDay, other, undated]);
    expect(items.map((i) => i.start)).toEqual(["2026-11-06", "2026-11-07"]);
  });
});

describe("layoutTimed", () => {
  it("puts overlapping tasks side by side and resets after a gap", () => {
    const a = task({ startTime: "09:00", durationMin: 60 });
    const b = task({ startTime: "09:30", durationMin: 60 });
    const c = task({ startTime: "10:00", durationMin: 30 }); // a has ended, fits in col 0
    const d = task({ startTime: "13:00" }); // alone
    const blocks = layoutTimed([d, c, b, a]);
    const by = (t: Task) => blocks.find((x) => x.task === t)!;
    expect(by(a)).toMatchObject({ col: 0, cols: 2 });
    expect(by(b)).toMatchObject({ col: 1, cols: 2 });
    expect(by(c)).toMatchObject({ col: 0, cols: 2 });
    expect(by(d)).toMatchObject({ col: 0, cols: 1, endMin: 13 * 60 + 30 });
  });
});

describe("textOn", () => {
  it("picks a readable text colour", () => {
    expect(textOn("#ffffff")).toBe("#10131a");
    expect(textOn("#1e1e64")).toBe("#ffffff");
  });
});
