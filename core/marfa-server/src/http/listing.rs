use std::str::FromStr;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use marfa_rules::query::{SortDirection, SortField, list_entry, refuse_states, type_entries};
use marfa_rules::{filter, time, validation};
use serde_json::Value;

use super::answer::{Answer, json_answer, text_answer};
use super::items::invalid_field;
use super::query;
use crate::app::App;
use crate::app::access::Caller;
use crate::app::items::Many;
use crate::app::query::{
    Ask, By, Filter, Listing, Search, Sort, States, list, search as run_search, stats as run_stats,
};
use crate::app::refusal::{Code, Refusal, Result};

const ITEMS_PAGE: i64 = 50;
const MAX_ITEMS_PAGE: i64 = 500;
const SEARCH_PAGE: i64 = 20;
const MAX_SEARCH_PAGE: i64 = 100;
const STATES: [&str; 4] = ["active", "archived", "trashed", "revoked"];
const TIERS: [&str; 3] = ["library", "feed", "all"];
const NARROWING: [&str; 4] = ["type", "source", "tags", "filter"];

pub(super) const ITEMS_QUERY: [&str; 16] = [
    "type",
    "state",
    "source",
    "tier",
    "tags",
    "filter",
    "beneath",
    "sort",
    "direction",
    "limit",
    "cursor",
    "include",
    "occurred_after",
    "occurred_before",
    "updated_after",
    "updated_before",
];
const STATS_QUERY: [&str; 13] = [
    "type",
    "state",
    "source",
    "tier",
    "tags",
    "filter",
    "beneath",
    "by",
    "include",
    "occurred_after",
    "occurred_before",
    "updated_after",
    "updated_before",
];
pub(super) const SEARCH_QUERY: [&str; 16] = [
    "q",
    "type",
    "state",
    "source",
    "tier",
    "include",
    "tags",
    "limit",
    "cursor",
    "filter",
    "sort",
    "direction",
    "occurred_after",
    "occurred_before",
    "updated_after",
    "updated_before",
];

fn is_shorthand(key: &str) -> bool {
    ["edge[", "backref["].iter().any(|open| {
        key.strip_prefix(open)
            .and_then(|rest| rest.strip_suffix(']'))
            .is_some_and(|name| {
                !name.is_empty() && !name.chars().any(|c| c == ']' || c.is_whitespace())
            })
    })
}

fn is_blank(value: &str) -> bool {
    value.split(',').all(|entry| entry.trim().is_empty())
}

pub struct Params {
    pairs: Vec<(String, String)>,
}

impl Params {
    pub fn read(uri: &Uri, allowed: &[&str], shorthand: bool) -> Result<Params> {
        query::only_where(uri, |key| {
            allowed.contains(&key) || (shorthand && is_shorthand(key))
        })?;
        Params::from_pairs(query::pairs(uri)?, allowed)
    }

    /// Parameters a caller other than a query string names; `allowed` is what the operation takes.
    pub(super) fn from_pairs(pairs: Vec<(String, String)>, allowed: &[&str]) -> Result<Params> {
        let mut empty: Vec<&str> = NARROWING
            .into_iter()
            .filter(|name| allowed.contains(name))
            .filter(|name| {
                pairs
                    .iter()
                    .any(|(key, value)| key == name && is_blank(value))
            })
            .collect();
        empty.sort_unstable();
        if !empty.is_empty() {
            return Err(Refusal::validation(format!(
                "These parameters hold no value: {}.",
                empty.join(", ")
            ))
            .with_detail("empty_parameters", empty));
        }
        Ok(Params { pairs })
    }

    /// A list is a single value with commas in it, so a key sent twice says two things.
    pub fn one(&self, name: &str) -> Result<Option<&str>> {
        let mut named = self
            .pairs
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_str());
        let first = named.next();
        if named.next().is_some() {
            return Err(invalid_field(name, format!("{name} is named twice.")));
        }
        Ok(first)
    }

    fn time(&self, name: &str) -> Result<Option<String>> {
        self.one(name)?
            .map(|value| {
                time::normalize_bound(value, name)
                    .map_err(|error| invalid_field(name, error.message))
            })
            .transpose()
    }

    fn shorthand(&self) -> Result<Vec<String>> {
        let mut terms = Vec::new();
        for (key, value) in self.pairs.iter().filter(|(key, _)| is_shorthand(key)) {
            if value.trim().is_empty() {
                return Err(Refusal::validation(format!("{key} holds no value."))
                    .with_detail("empty_parameters", [key.as_str()]));
            }
            if value.contains('\\') {
                return Err(Refusal::validation(format!("{key} holds a backslash."))
                    .with_detail("invalid_parameters", [key.as_str()]));
            }
            terms.push(format!("{key} eq \"{}\"", value.replace('"', "\\\"")));
        }
        Ok(terms)
    }
}

pub fn whole_limit(params: &Params, default: i64, most: i64) -> Result<i64> {
    let Some(value) = params.one("limit")? else {
        return Ok(default);
    };
    value
        .parse::<i64>()
        .ok()
        .filter(|limit| (1..=most).contains(limit))
        .ok_or_else(|| invalid_field("limit", format!("limit is a whole number, 1 to {most}.")))
}

fn capped_limit(params: &Params, default: i64, most: i64) -> Result<i64> {
    let Some(value) = params.one("limit")? else {
        return Ok(default);
    };
    let digits = !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
    if !digits || value.bytes().all(|byte| byte == b'0') {
        return Err(invalid_field("limit", "limit is a whole number above 0."));
    }
    Ok(value.parse::<i64>().map_or(most, |limit| limit.min(most)))
}

fn types_of(value: &str) -> Result<Vec<String>> {
    let refused = |error: marfa_rules::error::RuleError| invalid_field("type", error.message);
    let sent: Vec<String> = value.split(',').map(str::to_string).collect();
    let entries = type_entries(&sent).map_err(refused)?;
    entries
        .into_iter()
        .map(|entry| list_entry(entry).map(str::to_string).map_err(refused))
        .collect()
}

fn states_of(value: &str) -> Result<States> {
    let entries: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    let every = entries.contains(&"any");
    let named: Vec<String> = entries
        .iter()
        .filter(|entry| **entry != "any")
        .map(|entry| entry.to_string())
        .collect();
    if every && entries.len() == 1 {
        return Ok(States::Every);
    }
    refuse_states(Some(named.len()), every)
        .map_err(|error| invalid_field("state", error.message))?;
    if let Some(entry) = named.iter().find(|entry| !STATES.contains(&entry.as_str())) {
        return Err(invalid_field(
            "state",
            format!("{entry} is not a state: name a lifecycle state or any."),
        ));
    }
    Ok(States::Named(named))
}

fn tier_of(params: &Params) -> Result<Option<String>> {
    let Some(tier) = params.one("tier")? else {
        return Ok(None);
    };
    if !TIERS.contains(&tier) {
        return Err(invalid_field("tier", "tier is library, feed or all."));
    }
    Ok(Some(tier).filter(|tier| *tier != "all").map(str::to_string))
}

fn filter_of(params: &Params) -> Result<Option<Filter>> {
    let mut terms: Vec<String> = params
        .one("filter")?
        .map(str::to_string)
        .into_iter()
        .collect();
    terms.extend(params.shorthand()?);
    if terms.is_empty() {
        return Ok(None);
    }
    let text = terms.join(" AND ");
    let expression =
        filter::parse(&text).map_err(|error| invalid_field("filter", error.message))?;
    Ok(Some(Filter { text, expression }))
}

fn beneath_of(params: &Params) -> Result<Option<String>> {
    let Some(id) = params.one("beneath")? else {
        return Ok(None);
    };
    validation::id("beneath", id).map_err(|_| {
        Refusal::validation("beneath must be an item ID.")
            .with_detail("invalid_parameters", ["beneath"])
    })?;
    Ok(Some(id.to_string()))
}

fn ask_of(params: &Params, default: States) -> Result<Ask> {
    let tags = params
        .one("tags")?
        .into_iter()
        .flat_map(|tags| tags.split(','))
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect();
    Ok(Ask {
        types: params.one("type")?.map_or(Ok(Vec::new()), types_of)?,
        system: false,
        states: params.one("state")?.map_or(Ok(default), states_of)?,
        source: params.one("source")?.map(str::to_string),
        tier: tier_of(params)?,
        tags,
        filter: filter_of(params)?,
        beneath: beneath_of(params)?,
        occurred_after: params.time("occurred_after")?,
        occurred_before: params.time("occurred_before")?,
        updated_after: params.time("updated_after")?,
        updated_before: params.time("updated_before")?,
    })
}

fn active() -> States {
    States::Named(vec!["active".to_string()])
}

fn direction_of(params: &Params) -> Result<Option<SortDirection>> {
    match params.one("direction")? {
        None => Ok(None),
        Some("asc") => Ok(Some(SortDirection::Ascending)),
        Some("desc") => Ok(Some(SortDirection::Descending)),
        Some(_) => Err(invalid_field("direction", "direction is asc or desc.")),
    }
}

fn field_of(sort: &str) -> Result<SortField> {
    SortField::from_str(sort).map_err(|error| invalid_field("sort", error.message))
}

fn many_of(params: &Params) -> Result<Many> {
    let mut many = Many::default();
    for token in params
        .one("include")?
        .into_iter()
        .flat_map(|tokens| tokens.split(','))
        .map(str::trim)
    {
        match token {
            "" => {}
            "metadata" => many.metadata = true,
            "edges" => many.edges = true,
            "extensions" => many.extensions = true,
            "system" => many.system = true,
            other => {
                return Err(invalid_field(
                    "include",
                    format!("include does not take {other}."),
                ));
            }
        }
    }
    Ok(many)
}

fn refuse_order_beside_updated_after(sort: &Sort, sent_sort: Option<&str>) -> Result<()> {
    if sent_sort.is_some_and(|sent| sent != "updated_at") {
        return Err(invalid_field(
            "sort",
            "updated_after reads in updated_at order.",
        ));
    }
    if matches!(sort.direction, Some(SortDirection::Descending)) {
        return Err(invalid_field(
            "direction",
            "updated_after reads in ascending order.",
        ));
    }
    Ok(())
}

pub async fn items(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require_reach()?;
    let params = Params::read(&uri, &ITEMS_QUERY, true)?;
    Ok(text_answer(
        StatusCode::OK,
        items_from(&app, &caller, &params).await?,
    ))
}

/// The page of items `params` asks for, as the listing door answers it.
pub(super) async fn items_from(app: &App, caller: &Caller, params: &Params) -> Result<String> {
    let mut ask = ask_of(params, active())?;
    let include = many_of(params)?;
    ask.system = include.system;
    let sent_sort = params.one("sort")?;
    let sort = Sort {
        field: sent_sort.map(field_of).transpose()?,
        direction: direction_of(params)?,
    };
    if ask.updated_after.is_some() {
        refuse_order_beside_updated_after(&sort, sent_sort)?;
    }
    let listing = Listing {
        ask,
        sort,
        limit: capped_limit(params, ITEMS_PAGE, MAX_ITEMS_PAGE)?,
        cursor: params.one("cursor")?.map(str::to_string),
        include,
    };
    list(app, caller, listing).await
}

fn by_of(params: &Params) -> Result<By> {
    match params.one("by")? {
        None | Some("state") => Ok(By::State),
        Some("type") => Ok(By::Type),
        Some("source") => Ok(By::Source),
        Some(_) => Err(invalid_field("by", "by is state, type or source.")),
    }
}

pub async fn stats(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require_reach()?;
    let params = Params::read(&uri, &STATS_QUERY, true)?;
    let mut ask = ask_of(&params, States::Every)?;
    ask.system = match params.one("include")? {
        None => false,
        Some("system") => true,
        Some(_) => return Err(invalid_field("include", "include takes system.").into()),
    };
    let by = by_of(&params)?;
    let counts = run_stats(&app, &caller, ask, by).await?;
    Ok(json_answer(StatusCode::OK, &Value::Object(counts)))
}

fn query_of(params: &Params) -> Result<String> {
    let Some(q) = params.one("q")? else {
        return Err(
            Refusal::new(Code::MissingRequiredField, "q is required.").with_detail("field", "q")
        );
    };
    if q.is_empty() {
        return Err(invalid_field("q", "q holds no value."));
    }
    if q.contains('\0') {
        return Err(invalid_field("q", "q cannot hold a NUL character."));
    }
    Ok(q.trim().to_string())
}

fn search_sort_of(params: &Params) -> Result<Sort> {
    let field = match params.one("sort")? {
        None | Some("relevance") => None,
        Some(sent) => Some(field_of(sent)?),
    };
    Ok(Sort {
        field,
        direction: direction_of(params)?,
    })
}

pub async fn search(State(app): State<Arc<App>>, caller: Caller, uri: Uri) -> Answer {
    caller.require_reach()?;
    let params = Params::read(&uri, &SEARCH_QUERY, false)?;
    Ok(text_answer(
        StatusCode::OK,
        search_from(&app, &caller, &params).await?,
    ))
}

/// The page of hits `params` asks for, as the search door answers it.
pub(super) async fn search_from(app: &App, caller: &Caller, params: &Params) -> Result<String> {
    let q = query_of(params)?;
    let mut ask = ask_of(params, active())?;
    let mut include: Vec<String> = params
        .one("include")?
        .into_iter()
        .flat_map(|tokens| tokens.split(','))
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .collect();
    include.sort_unstable();
    include.dedup();
    ask.system = include.iter().any(|token| token == "system");
    let found = Search {
        q,
        ask,
        sort: search_sort_of(params)?,
        limit: whole_limit(params, SEARCH_PAGE, MAX_SEARCH_PAGE)?,
        cursor: params.one("cursor")?.map(str::to_string),
        include,
    };
    run_search(app, caller, found).await
}

#[cfg(test)]
mod tests {
    use super::types_of;

    #[test]
    fn a_bare_star_is_refused_and_a_type_or_a_wildcard_under_one_is_taken() {
        assert!(types_of("*").is_err());
        assert!(types_of("core.note,*").is_err());
        assert_eq!(types_of("core.note").unwrap(), vec!["core.note"]);
        assert_eq!(types_of("core.*").unwrap(), vec!["core.*"]);
    }
}
