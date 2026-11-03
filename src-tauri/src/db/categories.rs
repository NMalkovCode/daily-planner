use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use super::{Error, Result};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub colour: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInput {
    pub name: String,
    pub colour: String,
}

fn from_row(r: &Row) -> rusqlite::Result<Category> {
    Ok(Category {
        id: r.get("id")?,
        name: r.get("name")?,
        colour: r.get("colour")?,
        sort_order: r.get("sort_order")?,
    })
}

fn clean(mut c: CategoryInput) -> Result<CategoryInput> {
    c.name = c.name.trim().to_string();
    c.colour = c.colour.trim().to_lowercase();
    if c.name.is_empty() {
        return Err(Error::Invalid("Category name can't be empty".into()));
    }
    let hex = c.colour.strip_prefix('#').unwrap_or("");
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Invalid("Colour must look like #3b82f6".into()));
    }
    Ok(c)
}

fn map_unique(e: rusqlite::Error) -> Error {
    match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            Error::Invalid("A category with that name already exists".into())
        }
        other => other.into(),
    }
}

pub fn list(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare("SELECT * FROM categories ORDER BY sort_order, name")?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Category> {
    Ok(conn.query_row("SELECT * FROM categories WHERE id = ?1", [id], from_row)?)
}

pub fn create(conn: &Connection, input: CategoryInput) -> Result<Category> {
    let c = clean(input)?;
    conn.execute(
        "INSERT INTO categories (name, colour, sort_order)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))",
        params![c.name, c.colour],
    )
    .map_err(map_unique)?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, input: CategoryInput) -> Result<Category> {
    let c = clean(input)?;
    let changed = conn
        .execute(
            "UPDATE categories SET name = ?1, colour = ?2 WHERE id = ?3",
            params![c.name, c.colour, id],
        )
        .map_err(map_unique)?;
    if changed == 0 {
        return Err(Error::NotFound);
    }
    get(conn, id)
}

/// Deletes a category; its tasks are kept and become uncategorised.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    if conn.execute("DELETE FROM categories WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, tasks};

    fn input(name: &str, colour: &str) -> CategoryInput {
        CategoryInput {
            name: name.into(),
            colour: colour.into(),
        }
    }

    #[test]
    fn defaults_are_seeded() {
        let db = open_in_memory().unwrap();
        let names: Vec<_> = list(&db).unwrap().into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["Work", "Personal", "Health", "Study"]);
    }

    #[test]
    fn create_update_and_reject_duplicates() {
        let db = open_in_memory().unwrap();
        let c = create(&db, input("Hobbies", "#ABCDEF")).unwrap();
        assert_eq!(c.colour, "#abcdef");
        assert!(matches!(create(&db, input("work", "#000000")), Err(Error::Invalid(_))));
        assert!(create(&db, input("Bad", "blue")).is_err());
        assert_eq!(update(&db, c.id, input("Hobby", "#123456")).unwrap().name, "Hobby");
    }

    #[test]
    fn deleting_a_category_keeps_its_tasks() {
        let db = open_in_memory().unwrap();
        let c = create(&db, input("Temp", "#111111")).unwrap();
        let t = tasks::create(
            &db,
            tasks::TaskInput {
                title: "x".into(),
                category_id: Some(c.id),
                ..Default::default()
            },
        )
        .unwrap();
        delete(&db, c.id).unwrap();
        assert_eq!(tasks::get(&db, t.id).unwrap().category_id, None);
    }
}
