//! The rules of the edge graph: what an edge write may leave, and what a bin
//! takes. They read the graph through [`Graph`], so a store judges them on
//! the state its transaction holds, and they never recurse: stored data can
//! hold a cycle or a chain of any depth.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use serde_json::{Map, Value, json};

use crate::catalog::{EdgeType, End};

/// What deleting one end of an edge does to the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnDelete {
    Orphan,
    Cascade,
    Block,
    WithHosts,
}

impl OnDelete {
    /// The behavior a stored word names. A type no longer registered holds
    /// nothing back and takes nothing with it.
    pub fn of(word: Option<&str>) -> OnDelete {
        match word {
            Some("cascade") => OnDelete::Cascade,
            Some("block") => OnDelete::Block,
            Some("with-hosts") => OnDelete::WithHosts,
            _ => OnDelete::Orphan,
        }
    }
}

/// An edge as the graph holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub id: String,
    pub edge_type: String,
    pub source: String,
    pub target: String,
}

/// The graph as a store holds it now.
pub trait Graph {
    type Error;

    /// The edges leaving `id`, whatever their types.
    fn outbound(&self, id: &str) -> Result<Vec<Link>, Self::Error>;
    /// The edges arriving at `id`, whatever their types.
    fn inbound(&self, id: &str) -> Result<Vec<Link>, Self::Error>;
    /// The id of the edge holding this triple.
    fn triple(
        &self,
        source: &str,
        target: &str,
        edge_type: &str,
    ) -> Result<Option<String>, Self::Error>;
    /// Whether `id` is a row in the bin. A row the store does not hold is not.
    fn in_bin(&self, id: &str) -> Result<bool, Self::Error>;
    /// Whether the store holds a row for `id`.
    fn holds(&self, id: &str) -> Result<bool, Self::Error>;
    fn on_delete(&self, edge_type: &str) -> OnDelete;
}

/// An edge as a write would leave it.
#[derive(Debug, Clone, Copy)]
pub struct Proposed<'a> {
    pub edge_type: &'a str,
    pub source: &'a str,
    pub target: &'a str,
    /// The stored edge this write moves, which counts for nothing against it.
    pub moving: Option<&'a str>,
}

/// The stored edge that already holds this triple, the moved edge aside.
pub fn duplicate<G: Graph>(graph: &G, edge: &Proposed<'_>) -> Result<Option<String>, G::Error> {
    Ok(graph
        .triple(edge.source, edge.target, edge.edge_type)?
        .filter(|held| Some(held.as_str()) != edge.moving))
}

/// The end that would hold more edges of the type than its cardinality
/// allows, the source judged first.
pub fn full_end<G: Graph>(
    graph: &G,
    edge_type: &EdgeType,
    edge: &Proposed<'_>,
) -> Result<Option<End>, G::Error> {
    let holds_one = |links: Vec<Link>| {
        links
            .iter()
            .any(|link| link.edge_type == edge.edge_type && Some(link.id.as_str()) != edge.moving)
    };
    if edge_type.one_at(End::Source) && holds_one(graph.outbound(edge.source)?) {
        return Ok(Some(End::Source));
    }
    if edge_type.one_at(End::Target) && holds_one(graph.inbound(edge.target)?) {
        return Ok(Some(End::Target));
    }
    Ok(None)
}

/// Whether the edge would close a cycle through edges whose types `follows`
/// admits, the moved edge aside.
pub fn closes_cycle<G: Graph>(
    graph: &G,
    edge: &Proposed<'_>,
    follows: impl Fn(&str) -> bool,
) -> Result<bool, G::Error> {
    let mut seen = HashSet::from([edge.target.to_string()]);
    let mut waiting = vec![edge.target.to_string()];
    while let Some(at) = waiting.pop() {
        if at == edge.source {
            return Ok(true);
        }
        for link in graph.outbound(&at)? {
            if follows(&link.edge_type)
                && Some(link.id.as_str()) != edge.moving
                && seen.insert(link.target.clone())
            {
                waiting.push(link.target);
            }
        }
    }
    Ok(false)
}

/// What moving the named rows to the bin together takes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Closure {
    /// Every row reached, leaves first, each group together and its root last.
    pub ordered: Vec<String>,
    /// The named row each reached row goes with.
    pub root_of: HashMap<String, String>,
    /// What lies beneath each named row, leaves first. A row two named rows
    /// share is beneath both.
    pub beneath: HashMap<String, Vec<String>>,
    /// The rows taken as parts, which no cascading edge reached.
    pub with_hosts: HashSet<String>,
}

/// One closure over two rules, run until nothing new joins: the target of a
/// cascading edge from a row in the set, and the source of a `with-hosts`
/// edge once every host it holds is in the set or the bin. A named part is
/// judged only once the set is known: where its hosts all go it goes beneath
/// them, and where one stays it heads its own group. Rows already in the bin
/// are walked through and stand in `ordered`; moving them is the caller's to
/// skip.
pub fn closure<G: Graph>(graph: &G, named: &[String]) -> Result<Closure, G::Error> {
    let mut roots = Vec::new();
    let mut named_once = HashSet::new();
    for id in named {
        if named_once.insert(id.as_str()) {
            roots.push(id.clone());
        }
    }
    let mut walk = Walk {
        graph,
        set: HashSet::new(),
        cascaded: HashSet::new(),
        children: HashMap::new(),
        candidates: BTreeMap::new(),
        waiting: roots.iter().cloned().collect(),
    };
    walk.drain()?;
    loop {
        let joining = walk.joining_parts()?;
        if joining.is_empty() {
            break;
        }
        for part in joining {
            for host in walk.candidates.remove(&part).unwrap_or_default() {
                walk.children.entry(host).or_default().push(part.clone());
            }
            walk.waiting.push_back(part);
        }
        walk.drain()?;
    }
    walk.place_named_parts(&roots)?;
    Ok(walk.settled(&roots))
}

/// One closure as it grows.
struct Walk<'g, G> {
    graph: &'g G,
    set: HashSet<String>,
    cascaded: HashSet<String>,
    /// Each row's children in the plan: its cascade targets and its parts.
    children: HashMap<String, Vec<String>>,
    /// The sources of `with-hosts` edges into the set, with the hosts in it.
    candidates: BTreeMap<String, Vec<String>>,
    waiting: VecDeque<String>,
}

impl<G: Graph> Walk<'_, G> {
    fn drain(&mut self) -> Result<(), G::Error> {
        while let Some(id) = self.waiting.pop_front() {
            if !self.set.insert(id.clone()) {
                continue;
            }
            self.children.entry(id.clone()).or_default();
            for link in self.graph.outbound(&id)? {
                if self.graph.on_delete(&link.edge_type) == OnDelete::Cascade {
                    self.cascaded.insert(link.target.clone());
                    self.children
                        .entry(id.clone())
                        .or_default()
                        .push(link.target.clone());
                    self.waiting.push_back(link.target);
                }
            }
            for link in self.graph.inbound(&id)? {
                if self.graph.on_delete(&link.edge_type) == OnDelete::WithHosts {
                    self.candidates
                        .entry(link.source)
                        .or_default()
                        .push(id.clone());
                }
            }
        }
        Ok(())
    }

    /// The hosts of `part`, each once.
    fn hosts(&self, part: &str) -> Result<Vec<String>, G::Error> {
        let mut seen = HashSet::new();
        Ok(self
            .graph
            .outbound(part)?
            .into_iter()
            .filter(|link| self.graph.on_delete(&link.edge_type) == OnDelete::WithHosts)
            .map(|link| link.target)
            .filter(|host| seen.insert(host.clone()))
            .collect())
    }

    fn all_gone_but(&self, hosts: &[String]) -> Result<bool, G::Error> {
        for host in hosts {
            if !self.set.contains(host) && !self.graph.in_bin(host)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// The candidates whose hosts are now all in the set or the bin. One not
    /// joining now may join once more of its hosts are in.
    fn joining_parts(&mut self) -> Result<Vec<String>, G::Error> {
        let pending: Vec<String> = self
            .candidates
            .keys()
            .filter(|id| !self.set.contains(*id))
            .cloned()
            .collect();
        let mut joining = Vec::new();
        for part in pending {
            if !self.graph.holds(&part)? || self.graph.in_bin(&part)? {
                self.candidates.remove(&part);
            } else if self.all_gone_but(&self.hosts(&part)?)? {
                joining.push(part);
            }
        }
        Ok(joining)
    }

    fn place_named_parts(&mut self, roots: &[String]) -> Result<(), G::Error> {
        for id in roots {
            if self.graph.in_bin(id)? {
                continue;
            }
            let hosts = self.hosts(id)?;
            if !hosts.iter().any(|host| self.set.contains(host)) || !self.all_gone_but(&hosts)? {
                continue;
            }
            for host in hosts {
                if self.set.contains(&host) {
                    self.children.entry(host).or_default().push(id.clone());
                }
            }
        }
        Ok(())
    }

    /// Leaves first and `start` last.
    fn post_order(&self, start: &str, placed: &mut HashSet<String>) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![(start.to_string(), 0)];
        placed.insert(start.to_string());
        while let Some((id, next)) = stack.last_mut() {
            let child = self
                .children
                .get(id.as_str())
                .and_then(|kids| kids.get(*next));
            *next += 1;
            match child {
                Some(child) => {
                    if self.set.contains(child) && placed.insert(child.clone()) {
                        stack.push((child.clone(), 0));
                    }
                }
                None => {
                    out.push(id.clone());
                    stack.pop();
                }
            }
        }
        out
    }

    fn settled(&self, roots: &[String]) -> Closure {
        let mut reached = HashSet::new();
        let mut frontier: Vec<&String> = roots
            .iter()
            .filter_map(|id| self.children.get(id))
            .flatten()
            .collect();
        while let Some(id) = frontier.pop() {
            if reached.insert(id.as_str()) {
                frontier.extend(self.children.get(id).into_iter().flatten());
            }
        }
        // Roots no other root reaches lead; any left, such as the roots of a
        // cycle, each head their own group.
        let (free, reached_roots): (Vec<&String>, Vec<&String>) =
            roots.iter().partition(|id| !reached.contains(id.as_str()));
        let mut closure = Closure::default();
        let mut placed = HashSet::new();
        for root in free.into_iter().chain(reached_roots) {
            if placed.contains(root) {
                continue;
            }
            for id in self.post_order(root, &mut placed) {
                closure.root_of.insert(id.clone(), root.clone());
                closure.ordered.push(id);
            }
        }
        for root in roots {
            let mut below = self.post_order(root, &mut HashSet::new());
            below.pop();
            closure.beneath.insert(root.clone(), below);
        }
        closure.with_hosts = closure
            .ordered
            .iter()
            .filter(|id| closure.root_of.get(*id) != Some(*id) && !self.cascaded.contains(*id))
            .cloned()
            .collect();
        closure
    }
}

/// The block edges standing at either end of `rows`, each once.
pub fn blocking<G: Graph>(graph: &G, rows: &[String]) -> Result<Vec<Link>, G::Error> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for row in rows {
        let links = graph.outbound(row)?.into_iter().chain(graph.inbound(row)?);
        for link in links {
            if graph.on_delete(&link.edge_type) == OnDelete::Block && seen.insert(link.id.clone()) {
                found.push(link);
            }
        }
    }
    Ok(found)
}

/// Every row the cascading edges out of `start` reach, `start` aside.
pub fn cascade_reach<G: Graph>(graph: &G, start: &str) -> Result<Vec<String>, G::Error> {
    let mut seen = HashSet::from([start.to_string()]);
    let mut waiting = vec![start.to_string()];
    let mut reached = Vec::new();
    while let Some(at) = waiting.pop() {
        for link in graph.outbound(&at)? {
            if graph.on_delete(&link.edge_type) == OnDelete::Cascade
                && seen.insert(link.target.clone())
            {
                reached.push(link.target.clone());
                waiting.push(link.target);
            }
        }
    }
    Ok(reached)
}

/// How many names deep a path lies inside a folder, or none where it does
/// not lie inside one.
pub fn depth_inside_folder(path: &str) -> Option<usize> {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if drive || path.starts_with('/') || path.contains(['\\', '\0']) {
        return None;
    }
    let mut depth = 0;
    for name in path.split('/') {
        match name {
            ".." => return None,
            "" | "." => {}
            _ => depth += 1,
        }
    }
    Some(depth)
}

/// A refusal of a graph rule: what the answer says, and what it names.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub message: String,
    pub details: Value,
}

pub fn refused_end(edge_type: &EdgeType, end: End, item_type: &str) -> Refused {
    let id = &edge_type.id;
    let (end, allowed) = match end {
        End::Source => ("source", &edge_type.source_type_constraints),
        End::Target => ("target", &edge_type.target_type_constraints),
    };
    let mut details = Map::new();
    details.insert("edge_type".into(), json!(id));
    details.insert(format!("{end}_type"), json!(item_type));
    details.insert("allowed".into(), json!(allowed));
    Refused {
        message: format!("Edge \"{id}\" does not allow {end} type \"{item_type}\""),
        details: Value::Object(details),
    }
}

pub fn refused_nesting(edge_type: &str, source_id: &str, source_type: &str) -> Refused {
    Refused {
        message: format!(
            "Edge \"{edge_type}\" does not take a source its target constraints admit; use \"parent-of\" for hierarchy"
        ),
        details: json!({
            "edge_type": edge_type,
            "source_id": source_id,
            "source_type": source_type,
            "constraint": "nesting",
        }),
    }
}

pub fn refused_cardinality(edge_type: &EdgeType, end: End, at: &str) -> Refused {
    let (end, edge) = match end {
        End::Source => ("source", "outbound"),
        End::Target => ("target", "inbound"),
    };
    let mut details = Map::new();
    details.insert("edge_type".into(), json!(edge_type.id));
    details.insert(format!("{end}_id"), json!(at));
    details.insert("constraint".into(), json!("cardinality"));
    Refused {
        message: format!(
            "Edge \"{}\" is {}; {end} already has an {edge} edge of this type",
            edge_type.id, edge_type.cardinality
        ),
        details: Value::Object(details),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    /// (edge type, source, target), named `e<n>` by position.
    #[derive(Default)]
    struct Held {
        edges: Vec<(&'static str, String, String)>,
        binned: Vec<String>,
        deep: bool,
    }

    fn graph(edges: &[(&'static str, &str, &str)], binned: &[&str]) -> Held {
        Held {
            edges: edges
                .iter()
                .map(|(kind, source, target)| (*kind, source.to_string(), target.to_string()))
                .collect(),
            binned: binned.iter().map(|id| id.to_string()).collect(),
            deep: false,
        }
    }

    impl Held {
        fn links(&self, keep: impl Fn(&Link) -> bool) -> Vec<Link> {
            self.edges
                .iter()
                .enumerate()
                .map(|(at, (kind, source, target))| Link {
                    id: format!("e{at}"),
                    edge_type: kind.to_string(),
                    source: source.clone(),
                    target: target.clone(),
                })
                .filter(keep)
                .collect()
        }
    }

    impl Graph for Held {
        type Error = ();

        fn outbound(&self, id: &str) -> Result<Vec<Link>, ()> {
            if self.deep {
                let at: usize = id.parse().map_err(|_| ())?;
                return Ok(vec![Link {
                    id: format!("e{at}"),
                    edge_type: "parent-of".into(),
                    source: id.into(),
                    target: (at + 1).to_string(),
                }]
                .into_iter()
                .filter(|_| at + 1 < DEEP)
                .collect());
            }
            Ok(self.links(|link| link.source == id))
        }

        fn inbound(&self, id: &str) -> Result<Vec<Link>, ()> {
            if self.deep {
                return Ok(Vec::new());
            }
            Ok(self.links(|link| link.target == id))
        }

        fn triple(&self, source: &str, target: &str, kind: &str) -> Result<Option<String>, ()> {
            Ok(self
                .links(|link| {
                    link.source == source && link.target == target && link.edge_type == kind
                })
                .first()
                .map(|link| link.id.clone()))
        }

        fn in_bin(&self, id: &str) -> Result<bool, ()> {
            Ok(self.binned.iter().any(|held| held == id))
        }

        fn holds(&self, _id: &str) -> Result<bool, ()> {
            Ok(true)
        }

        fn on_delete(&self, edge_type: &str) -> OnDelete {
            match edge_type {
                "parent-of" => OnDelete::Cascade,
                "attached-to" | "comments-on" => OnDelete::WithHosts,
                "pins" => OnDelete::Block,
                _ => OnDelete::Orphan,
            }
        }
    }

    const DEEP: usize = 200_000;

    fn edge_type(id: &str, cardinality: &str) -> EdgeType {
        let wire = serde_json::from_value(json!({
            "id": id,
            "cardinality": cardinality,
            "written_at": "none",
            "source_type_constraints": [],
            "target_type_constraints": [],
            "cascade_on_delete": "orphan",
            "property_schema": {},
            "shipped": false,
        }))
        .expect("a whole edge type");
        EdgeType::from_wire(wire).expect("a whole edge type")
    }

    fn proposed<'a>(kind: &'a str, source: &'a str, target: &'a str) -> Proposed<'a> {
        Proposed {
            edge_type: kind,
            source,
            target,
            moving: None,
        }
    }

    #[test]
    fn a_held_triple_is_a_duplicate_unless_it_is_the_edge_moving() {
        let held = graph(&[("about", "a", "b")], &[]);
        let edge = proposed("about", "a", "b");
        assert_eq!(duplicate(&held, &edge), Ok(Some("e0".to_string())));
        assert_eq!(duplicate(&held, &proposed("about", "a", "c")), Ok(None));
        assert_eq!(
            duplicate(&held, &proposed("references", "a", "b")),
            Ok(None)
        );
        let moving = Proposed {
            moving: Some("e0"),
            ..edge
        };
        assert_eq!(duplicate(&held, &moving), Ok(None));
    }

    #[test]
    fn cardinality_is_judged_at_each_end_the_type_limits() {
        let held = graph(&[("x", "a", "b")], &[]);
        for (cardinality, source, target, moving, full) in [
            ("many-to-many", "a", "c", None, None),
            ("many-to-one", "a", "c", None, Some(End::Source)),
            ("many-to-one", "c", "b", None, None),
            ("one-to-many", "c", "b", None, Some(End::Target)),
            ("one-to-many", "a", "c", None, None),
            ("one-to-one", "a", "c", None, Some(End::Source)),
            ("one-to-one", "c", "b", None, Some(End::Target)),
            ("one-to-one", "a", "c", Some("e0"), None),
            ("many-to-one", "a", "c", Some("e0"), None),
        ] {
            let edge = Proposed {
                moving,
                ..proposed("x", source, target)
            };
            assert_eq!(
                full_end(&held, &edge_type("x", cardinality), &edge),
                Ok(full),
                "{cardinality} {source} to {target}"
            );
        }
    }

    #[test]
    fn a_cycle_is_found_through_the_edges_followed() {
        let held = graph(
            &[
                ("parent-of", "a", "b"),
                ("parent-of", "b", "c"),
                ("about", "c", "d"),
                ("attached-to", "p", "q"),
                ("comments-on", "q", "r"),
            ],
            &[],
        );
        let one = |wanted: &'static str| move |kind: &str| kind == wanted;
        let hosts = |kind: &str| matches!(kind, "attached-to" | "comments-on");
        assert_eq!(
            closes_cycle(&held, &proposed("parent-of", "c", "a"), one("parent-of")),
            Ok(true)
        );
        assert_eq!(
            closes_cycle(&held, &proposed("parent-of", "a", "c"), one("parent-of")),
            Ok(false)
        );
        assert_eq!(
            closes_cycle(&held, &proposed("parent-of", "d", "a"), one("parent-of")),
            Ok(false)
        );
        assert_eq!(
            closes_cycle(&held, &proposed("comments-on", "r", "p"), hosts),
            Ok(true),
            "a part of its own part across two types"
        );
        let moved = Proposed {
            moving: Some("e1"),
            ..proposed("parent-of", "c", "a")
        };
        assert_eq!(closes_cycle(&held, &moved, one("parent-of")), Ok(false));
    }

    #[test]
    fn a_cycle_already_stored_does_not_hang_the_search() {
        let held = graph(&[("parent-of", "a", "b"), ("parent-of", "b", "a")], &[]);
        assert_eq!(
            closes_cycle(&held, &proposed("parent-of", "x", "a"), |_| true),
            Ok(false)
        );
    }

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn a_cascade_runs_leaves_first_with_its_root_last() {
        let held = graph(
            &[
                ("parent-of", "a", "b"),
                ("parent-of", "b", "c"),
                ("about", "c", "d"),
            ],
            &[],
        );
        let taken = closure(&held, &ids(&["a"])).expect("in memory");
        assert_eq!(taken.ordered, ids(&["c", "b", "a"]));
        assert_eq!(taken.root_of["c"], "a");
        assert_eq!(taken.beneath["a"], ids(&["c", "b"]));
        assert!(taken.with_hosts.is_empty());
    }

    #[test]
    fn a_stored_cycle_ends_the_walk_with_each_row_once() {
        let held = graph(
            &[
                ("parent-of", "a", "b"),
                ("parent-of", "b", "c"),
                ("parent-of", "c", "a"),
            ],
            &[],
        );
        let taken = closure(&held, &ids(&["a"])).expect("in memory");
        assert_eq!(taken.ordered, ids(&["c", "b", "a"]));
    }

    #[test]
    fn a_chain_deeper_than_any_stack_is_walked() {
        let held = Held {
            deep: true,
            ..Held::default()
        };
        let taken = closure(&held, &ids(&["0"])).expect("in memory");
        assert_eq!(taken.ordered.len(), DEEP);
        assert_eq!(taken.ordered.last().map(String::as_str), Some("0"));
        assert_eq!(
            cascade_reach(&held, "0").expect("in memory").len(),
            DEEP - 1
        );
    }

    #[test]
    fn a_part_goes_only_once_every_host_is_going_or_in_the_bin() {
        let edges = [
            ("attached-to", "part", "h1"),
            ("attached-to", "part", "h2"),
            ("parent-of", "h1", "h2"),
        ];
        let parted = [("attached-to", "part", "h1"), ("attached-to", "part", "h2")];
        for (edges, binned, named, part_goes) in [
            (&parted[..], &[][..], &["h1"][..], false),
            (&parted[..], &["h2"][..], &["h1"][..], true),
            (&parted[..], &[][..], &["h1", "h2"][..], true),
            (&edges[..], &[][..], &["h1"][..], true),
        ] {
            let held = graph(edges, binned);
            let taken = closure(&held, &ids(named)).expect("in memory");
            assert_eq!(
                taken.ordered.iter().any(|id| id == "part"),
                part_goes,
                "{named:?} with {binned:?} in the bin"
            );
            assert_eq!(taken.with_hosts.contains("part"), part_goes);
        }
    }

    #[test]
    fn a_part_in_the_bin_is_left_where_it_is() {
        let held = graph(&[("attached-to", "part", "host")], &["part"]);
        let taken = closure(&held, &ids(&["host"])).expect("in memory");
        assert_eq!(taken.ordered, ids(&["host"]));
    }

    #[test]
    fn a_part_reached_by_a_cascade_is_not_a_part_that_went_with_hosts() {
        let held = graph(
            &[
                ("attached-to", "part", "host"),
                ("parent-of", "host", "part"),
            ],
            &[],
        );
        let taken = closure(&held, &ids(&["host"])).expect("in memory");
        assert!(taken.ordered.iter().any(|id| id == "part"));
        assert!(taken.with_hosts.is_empty());
    }

    #[test]
    fn a_part_is_judged_after_the_host_a_late_cascade_brings() {
        let held = graph(
            &[
                ("attached-to", "part", "h1"),
                ("attached-to", "part", "h2"),
                ("parent-of", "root", "h2"),
            ],
            &[],
        );
        let both = closure(&held, &ids(&["part", "h1", "root"])).expect("in memory");
        assert_eq!(both.root_of["part"], "h1");
        assert!(both.with_hosts.contains("part"));
        let alone = closure(&held, &ids(&["part", "h1"])).expect("in memory");
        assert_eq!(alone.root_of["part"], "part");
        assert!(alone.with_hosts.is_empty());
    }

    #[test]
    fn a_named_row_another_named_row_reaches_joins_its_group() {
        let held = graph(&[("parent-of", "a", "b"), ("parent-of", "b", "c")], &[]);
        let taken = closure(&held, &ids(&["c", "a"])).expect("in memory");
        assert_eq!(taken.ordered, ids(&["c", "b", "a"]));
        assert_eq!(taken.root_of["c"], "a");
        assert!(taken.beneath["c"].is_empty());
    }

    #[test]
    fn a_shared_row_lies_beneath_both_named_rows() {
        let held = graph(&[("parent-of", "a", "s"), ("parent-of", "b", "s")], &[]);
        let taken = closure(&held, &ids(&["a", "b"])).expect("in memory");
        assert_eq!(taken.beneath["a"], ids(&["s"]));
        assert_eq!(taken.beneath["b"], ids(&["s"]));
        assert_eq!(taken.ordered, ids(&["s", "a", "b"]));
    }

    #[test]
    fn a_cascade_walks_through_a_row_in_the_bin() {
        let held = graph(&[("parent-of", "a", "b"), ("parent-of", "b", "c")], &["b"]);
        let taken = closure(&held, &ids(&["a"])).expect("in memory");
        assert_eq!(taken.ordered, ids(&["c", "b", "a"]));
    }

    #[test]
    fn a_block_at_either_end_is_named_once() {
        let held = graph(
            &[("pins", "a", "b"), ("pins", "c", "a"), ("about", "a", "d")],
            &[],
        );
        let found = blocking(&held, &ids(&["a", "b"])).expect("in memory");
        let found: BTreeSet<&str> = found.iter().map(|link| link.id.as_str()).collect();
        assert_eq!(found, BTreeSet::from(["e0", "e1"]));
    }

    #[test]
    fn a_folder_path_lies_inside_the_folder() {
        for (path, depth) in [
            ("a.md", Some(1)),
            ("notes/a.md", Some(2)),
            ("./notes//a.md", Some(2)),
            ("", Some(0)),
            (".", Some(0)),
            ("notes/", Some(1)),
            ("/etc/passwd", None),
            ("C:/x", None),
            ("c:x", None),
            ("a\\b", None),
            ("a\0b", None),
            ("../a", None),
            ("a/../b", None),
            ("a..b/c", Some(2)),
        ] {
            assert_eq!(depth_inside_folder(path), depth, "{path:?}");
        }
    }
}
