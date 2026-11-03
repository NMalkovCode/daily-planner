import { describe, expect, it } from "vitest";
import type { Category } from "./api";
import { parseQuickAdd } from "./quickadd";

const TODAY = "2026-11-03"; // a Tuesday
const cats: Category[] = [
  { id: 1, name: "Work", colour: "#000000", sortOrder: 1 },
  { id: 2, name: "Health", colour: "#000000", sortOrder: 2 },
];
const p = (s: string) => parseQuickAdd(s, TODAY, cats).input;

describe("quick add", () => {
  it("leaves plain text alone", () => {
    expect(p("Buy milk")).toEqual({ title: "Buy milk" });
  });

  it("reads dates", () => {
    expect(p("Call mum tomorrow").date).toBe("2026-11-04");
    expect(p("Call mum today").date).toBe(TODAY);
    expect(p("Party fri").date).toBe("2026-11-06");
    expect(p("Party on Friday").date).toBe("2026-11-06");
    expect(p("Standup tue").date).toBe("2026-11-10"); // today is Tuesday: next week's
    expect(p("Review in 3 days").date).toBe("2026-11-06");
    expect(p("Review in 2 weeks").date).toBe("2026-11-17");
    expect(p("Plan next week").date).toBe("2026-11-09");
    expect(p("Dentist 12 nov").date).toBe("2026-11-12");
    expect(p("Dentist Nov 12th").date).toBe("2026-11-12");
    expect(p("Dentist 1/2").date).toBe("2027-02-01"); // day/month, already passed this year
    expect(p("Dentist 2026-12-24").date).toBe("2026-12-24");
    expect(p("Dentist 31/2").date).toBeUndefined();
  });

  it("reads times and durations", () => {
    const t = p("Dentist tomorrow at 3pm for 45m");
    expect(t).toMatchObject({ title: "Dentist", date: "2026-11-04", startTime: "15:00", durationMin: 45 });
    expect(p("Gym 18:30 for 1.5h")).toMatchObject({ title: "Gym", startTime: "18:30", durationMin: 90, date: TODAY });
    expect(p("Call at 9").startTime).toBe("09:00");
    expect(p("Call 12am").startTime).toBe("00:00");
    expect(p("Lunch 12:30pm").startTime).toBe("12:30");
  });

  it("reads deadlines separately from dates", () => {
    expect(p("Submit tax return by friday")).toEqual({ title: "Submit tax return", deadline: "2026-11-06" });
    expect(p("Essay tomorrow due 12 nov")).toMatchObject({ title: "Essay", date: "2026-11-04", deadline: "2026-11-12" });
  });

  it("reads priority, category and preparation", () => {
    expect(p("Interview fri #work !high +prep")).toEqual({
      title: "Interview",
      date: "2026-11-06",
      categoryId: 1,
      priority: "high",
      requiresPrep: true,
    });
    expect(p("Run #he !l")).toMatchObject({ title: "Run", categoryId: 2, priority: "low" });
    expect(p("Fix #bug")).toEqual({ title: "Fix #bug" }); // unknown category stays in the title
    expect(p("Ship it !!!").priority).toBe("high");
  });

  it("reads repeats", () => {
    expect(p("Water plants every day")).toMatchObject({ title: "Water plants", recurrenceRule: "daily", date: TODAY });
    expect(p("Stand-up every weekday 9:30")).toMatchObject({ recurrenceRule: "weekdays", startTime: "09:30" });
    expect(p("Bins every monday")).toMatchObject({ title: "Bins", recurrenceRule: "weekly:1", date: "2026-11-09" });
    expect(p("Bins every tuesday")).toMatchObject({ recurrenceRule: "weekly:2", date: TODAY });
    expect(p("Rent monthly 1 dec")).toMatchObject({ title: "Rent", recurrenceRule: "monthly", date: "2026-12-01" });
  });

  it("summarises what it understood", () => {
    expect(parseQuickAdd("Interview tomorrow 10am #work !high +prep", TODAY, cats).chips).toEqual([
      "Tomorrow",
      "10:00",
      "High priority",
      "Work",
      "Needs preparation",
    ]);
  });

  it("keeps the whole text if nothing is left for the title", () => {
    expect(p("tomorrow").title).toBe("tomorrow");
  });
});
