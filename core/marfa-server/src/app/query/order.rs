use marfa_rules::query::{SortDirection, SortField, property_sort_expression};
use rusqlite::types::Value;

use super::compile::{Ask, Sql, States};
use super::cursor::Position;

/// One sort key. A nullable key sorts its nulls last in either direction.
#[derive(Clone, Debug)]
pub struct Key {
    pub expression: Sql,
    pub descending: bool,
    pub nullable: bool,
    /// The search's own rank, which its select list names `rank` and orders by without computing it twice.
    pub relevance: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Sort {
    pub field: Option<SortField>,
    pub direction: Option<SortDirection>,
}

#[derive(Clone, Debug)]
pub struct Order {
    pub keys: Vec<Key>,
    pub id_descending: bool,
    pub spelled: String,
}

pub fn property_key(name: &str) -> Sql {
    let text = property_sort_expression("i.properties", "?");
    let mut sql = Sql::new(&text);
    let path = Value::Text(format!("$.{name}"));
    sql.values = vec![path; text.matches('?').count()];
    sql
}

fn column(name: &str) -> Sql {
    Sql::new(&format!("i.{name}"))
}

fn alias(at: usize) -> String {
    format!("k{at}")
}

fn word(descending: bool) -> &'static str {
    if descending { "desc" } else { "asc" }
}

impl Order {
    fn timed(expression: Sql, spelled: &str, descending: bool) -> Order {
        Order {
            keys: vec![Key {
                expression,
                descending,
                nullable: false,
                relevance: false,
            }],
            id_descending: descending,
            spelled: format!("{spelled} {}", word(descending)),
        }
    }

    fn by_property(name: &str, descending: bool) -> Order {
        Order {
            keys: vec![Key {
                expression: property_key(name),
                descending,
                nullable: true,
                relevance: false,
            }],
            id_descending: false,
            spelled: format!("properties.{name} {}", word(descending)),
        }
    }

    pub fn listing(sort: &Sort, ask: &Ask) -> Order {
        if ask.updated_after.is_some() {
            return Order::timed(column("updated_at"), "updated_at", false);
        }
        let descending = !matches!(sort.direction, Some(SortDirection::Ascending));
        let bin = ask.states == States::Named(vec!["trashed".to_string()]);
        match &sort.field {
            None if bin => Order::timed(
                Sql::new("COALESCE(i.trashed_at, i.updated_at)"),
                "bin",
                descending,
            ),
            None | Some(SortField::CreatedAt) => {
                Order::timed(column("created_at"), "created_at", descending)
            }
            Some(SortField::UpdatedAt) => {
                Order::timed(column("updated_at"), "updated_at", descending)
            }
            Some(SortField::OccurredAt) => {
                Order::timed(column("occurred_at"), "occurred_at", descending)
            }
            Some(SortField::LastActivityAt) => {
                Order::timed(column("last_activity_at"), "last_activity_at", descending)
            }
            Some(SortField::TrashedAt) => Order::timed(
                Sql::new("COALESCE(i.trashed_at, i.updated_at)"),
                "trashed_at",
                descending,
            ),
            Some(SortField::Property(name)) => Order::by_property(name, descending),
        }
    }

    /// The order of `GET /search`, best match first unless a sort says
    /// otherwise. A tie breaks by id ascending in either direction.
    pub fn search(sort: &Sort) -> Order {
        let ascending = matches!(sort.direction, Some(SortDirection::Ascending));
        let Some(field) = &sort.field else {
            return Order {
                keys: vec![Key {
                    expression: Sql::default(),
                    descending: ascending,
                    nullable: false,
                    relevance: true,
                }],
                id_descending: false,
                spelled: format!("relevance {}", word(!ascending)),
            };
        };
        let ask = Ask::default();
        let sorted = Sort {
            field: Some(field.clone()),
            direction: sort.direction,
        };
        Order {
            id_descending: false,
            ..Order::listing(&sorted, &ask)
        }
    }

    pub fn view(keys: Vec<Key>, id_descending: bool) -> Order {
        Order {
            keys,
            id_descending,
            spelled: String::new(),
        }
    }

    /// Whether a page walks an index of this order's own. Any other order is
    /// served by the type index, which holds each type's rows newest first.
    pub fn walked(&self) -> bool {
        matches!(
            self.keys.first().map(|key| key.expression.text.as_str()),
            Some("i.updated_at" | "i.occurred_at")
        )
    }

    /// Where a page of `ask` reads from. A sort no index holds reads every
    /// row, which the table gives in one pass and an index only row by row.
    pub fn table(&self, ask: &Ask) -> &'static str {
        let sorted_whole = self.keys.first().is_some_and(|key| key.nullable);
        if sorted_whole && !ask.leaves_few() && ask.beneath.is_none() {
            "items i NOT INDEXED"
        } else {
            "items i"
        }
    }

    /// Whether the search's rank is the only key, so that no column of the item is read to order.
    pub fn ranks_alone(&self) -> bool {
        self.keys.iter().all(|key| key.relevance)
    }

    pub fn width(&self) -> usize {
        self.keys.len()
    }

    pub fn columns(&self, sql: &mut Sql) {
        for (at, key) in self
            .keys
            .iter()
            .enumerate()
            .filter(|(_, key)| !key.relevance)
        {
            sql.append(&key.expression);
            sql.push(&format!(" AS {}, ", alias(at)));
        }
        sql.push("i.id");
    }

    pub fn order_by(&self, sql: &mut Sql) {
        self.order_by_named(sql, "i.id");
    }

    /// Orders the aliases emitted by [`Order::columns`].
    pub fn order_by_named(&self, sql: &mut Sql, id: &str) {
        sql.push(" ORDER BY ");
        for (at, key) in self.keys.iter().enumerate() {
            let name = if key.relevance {
                "rank".to_string()
            } else {
                alias(at)
            };
            if key.nullable {
                sql.push(&format!("{name} IS NULL, "));
            }
            sql.push(&name);
            sql.push(if key.descending { " DESC, " } else { " ASC, " });
        }
        sql.push(id);
        sql.push(if self.id_descending { " DESC" } else { " ASC" });
    }

    /// The condition for the rows after `position`. The position's values are
    /// compared, never looked up, so a row purged since still places a page.
    pub fn after(&self, sql: &mut Sql, position: &Position) {
        if let [key] = self.keys.as_slice()
            && !key.nullable
            && key.descending == self.id_descending
        {
            sql.push(&format!("({}, i.id) ", alias(0)));
            sql.push(if key.descending { "<" } else { ">" });
            sql.push(" (");
            sql.bind(position.keys[0].clone());
            sql.push(", ");
            sql.bind(position.id.clone());
            sql.push(")");
            return;
        }
        let mut tied = Sql::default();
        let mut branches = Vec::new();
        for (at, (key, value)) in self.keys.iter().zip(&position.keys).enumerate() {
            let name = alias(at);
            let is_null = matches!(value, Value::Null);
            if !is_null {
                let mut branch = tied.clone();
                branch.push("(");
                if key.nullable {
                    branch.push(&format!("{name} IS NULL OR "));
                }
                branch.push(&name);
                branch.push(if key.descending { " < " } else { " > " });
                branch.bind(value.clone());
                branch.push(")");
                branches.push(branch);
            }
            tied.push(&name);
            if is_null {
                tied.push(" IS NULL AND ");
            } else {
                tied.push(" = ");
                tied.bind(value.clone());
                tied.push(" AND ");
            }
        }
        let mut last = tied;
        last.push(if self.id_descending {
            "i.id < "
        } else {
            "i.id > "
        });
        last.bind(position.id.clone());
        branches.push(last);
        sql.push("(");
        for (at, branch) in branches.iter().enumerate() {
            if at > 0 {
                sql.push(" OR ");
            }
            sql.push("(");
            sql.append(branch);
            sql.push(")");
        }
        sql.push(")");
    }
}
