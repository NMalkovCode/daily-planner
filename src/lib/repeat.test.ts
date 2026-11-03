import { describe, expect, it } from "vitest";
import { describeRule, formatRule, isoWeekday, parseRule } from "./repeat";

describe("repeat rules", () => {
  it("round-trips the Rust format", () => {
    for (const s of ["daily", "daily/3", "weekdays", "weekly:1,3,5", "weekly/2:2", "monthly", "yearly;until=2030-01-01"]) {
      expect(formatRule(parseRule(s)!)).toBe(s);
    }
    expect(parseRule("hourly")).toBeNull();
    expect(parseRule(null)).toBeNull();
  });

  it("describes rules in plain English", () => {
    const d = (s: string, date = "2026-11-03") => describeRule(parseRule(s)!, date);
    expect(d("daily")).toBe("Every day");
    expect(d("daily/2")).toBe("Every 2 days");
    expect(d("weekdays")).toBe("Every weekday");
    expect(d("weekly")).toBe("Every week on Tue");
    expect(d("weekly/2:1,3")).toBe("Every 2 weeks on Mon, Wed");
    expect(d("weekly:1,2,3,4,5,6,7")).toBe("Every day");
    expect(d("monthly", "2026-11-23")).toBe("Every month on the 23rd");
    expect(d("monthly", "2026-11-11")).toBe("Every month on the 11th");
    expect(d("yearly")).toBe("Every year on 3 Nov");
    expect(d("daily;until=2027-03-01")).toBe("Every day until 1 Mar 2027");
  });

  it("numbers weekdays from Monday", () => {
    expect(isoWeekday("2026-11-02")).toBe(1);
    expect(isoWeekday("2026-11-08")).toBe(7);
  });
});
