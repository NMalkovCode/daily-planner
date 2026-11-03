//! Format checks for the date and time strings stored in the database.

/// `YYYY-MM-DD` with a real calendar day.
pub fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (Some(y), Some(m), Some(d)) = (num(&s[0..4]), num(&s[5..7]), num(&s[8..10])) else {
        return false;
    };
    (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)
}

/// `HH:MM`, 24-hour.
pub fn is_time(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return false;
    }
    matches!((num(&s[0..2]), num(&s[3..5])), (Some(h), Some(m)) if h < 24 && m < 60)
}

/// `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.
pub fn is_date_or_datetime(s: &str) -> bool {
    match s.len() {
        10 => is_date(s),
        16 => is_date(&s[..10]) && s.as_bytes()[10] == b' ' && is_time(&s[11..]),
        _ => false,
    }
}

fn num(s: &str) -> Option<u32> {
    if s.bytes().all(|c| c.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

fn days_in_month(y: u32, m: u32) -> u32 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert!(is_date("2026-11-03"));
        assert!(is_date("2028-02-29"));
        assert!(!is_date("2026-02-29"));
        assert!(!is_date("2026-13-01"));
        assert!(!is_date("2026-1-01"));
        assert!(!is_date("2026-11-03 10:00"));
    }

    #[test]
    fn times() {
        assert!(is_time("00:00"));
        assert!(is_time("23:59"));
        assert!(!is_time("24:00"));
        assert!(!is_time("9:30"));
        assert!(is_date_or_datetime("2026-11-03 09:30"));
        assert!(!is_date_or_datetime("2026-11-03T09:30"));
    }
}
