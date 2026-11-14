use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use clap::{Args, Subcommand};
use marfa_core::{
    Attachment, Core, Draft, EdgeDraft, EdgeEdit, Edit, ListFilters, MetadataWrite, SearchFilters,
    Sort,
};

use crate::error::{CliError, Exit};
use crate::interrupt::{stop_after, stop_on_interrupt};
use crate::output;
use crate::remote::{Named, Session, renewing};
use crate::values::{
    ItemState, SliceTier, SortDirection, Tier, edges, item_properties, parse_sort_field, properties,
};

#[derive(Debug, Args)]
pub struct DeviceArgs {
    /// The working copy's database file.
    #[arg(
        long,
        global = true,
        env = "MARFA_DB",
        value_name = "PATH",
        hide_env_values = true
    )]
    pub db: Option<PathBuf>,

    /// Open the store to read only: never claim the writer role, never
    /// write, and refuse a path where no store has been made.
    #[arg(long, global = true)]
    pub reader: bool,

    #[command(subcommand)]
    pub command: DeviceCommand,
}

#[derive(Debug, Subcommand)]
pub enum DeviceCommand {
    /// Replace the local copy with the declared types at one tier, or both.
    ///
    /// A hydration that stopped before it finished carries on from the page
    /// it had reached when run again for the same slice. It starts again
    /// from the first page, and says why, when another instance answers, the
    /// key's reach, the slice or the catalog has changed since, the server's
    /// event log no longer holds the point it started from or ends before
    /// it, or the server refuses the page cursor it kept.
    ///
    /// A copy whose cursor the server's event log no longer holds is filled
    /// again in place for the same slice, server and key: it keeps
    /// answering, marked stale, and takes writes to the items it holds and
    /// new ones, which wait to be sent, until the hydration finishes and
    /// removes the items the server no longer lists. Any other hydration
    /// empties the copy first. Until the copy is whole, a write to an edge is
    /// refused `hydration_incomplete`, since a page still to arrive could
    /// bring the server's edge in place of the one the write was made
    /// against.
    Hydrate {
        /// Comma-separated type identifiers, such as core.note,core.file, or
        /// `*` alone for every type but `system.*`, hydrated in one pass
        /// without reading the catalog first.
        #[arg(long, value_delimiter = ',', required = true, value_name = "TYPE")]
        types: Vec<String>,
        /// The tier to hold the slice at, or `all` for both.
        #[arg(long)]
        tier: SliceTier,
        /// An edge type to hold whole: every edge of it the key reads,
        /// whichever ends the copy holds. Repeatable.
        #[arg(long = "edge-type", value_name = "TYPE")]
        edge_types: Vec<String>,
        /// Fill only a copy whose cursor aged out, and only in place. Where
        /// the instance, the key's reach or the slice has changed, the
        /// server was restored to an earlier point, or the copy is not
        /// waiting to be filled again, the hydration is refused
        /// copy_expired with the reason before it changes anything, and the
        /// copy, its queue and its files stay as they were. Where the
        /// server refuses the key or its reach, the stale copy still ends,
        /// keeping the queue: `device status` then shows its hydration as
        /// expired, where a refused fill leaves a stale copy stale.
        #[arg(long)]
        in_place_only: bool,
    },
    /// Hold one item by id whatever the slice says of it, read now and kept
    /// current, even after it leaves the slice.
    Pin {
        /// The item id.
        id: String,
    },
    /// Stop holding an item by id; one the slice does not take goes.
    Unpin {
        /// The item id.
        id: String,
    },
    /// Apply every event since the last hydrate or catch-up.
    #[command(name = "catch-up")]
    CatchUp,
    /// Hold the event stream open and apply each event as it arrives,
    /// printing a line for each that changed the copy.
    ///
    /// On a copy never hydrated, or whose hydration was interrupted, it
    /// waits for a hydration and asks the server nothing, as an app's follow
    /// does. This process holds the store until it ends, so no other can
    /// hydrate it meanwhile: hydrate first. An expired copy is refused.
    ///
    /// When the server is reachable again after it was lost, it drains the
    /// queue once if writes wait, and prints `queue.drained` with what the
    /// drain did, or `queue.not_drained` with why it did not.
    Follow {
        /// Stop after this many seconds; without it, follow until
        /// interrupted. Either way it ends with its report.
        #[arg(long = "for", value_name = "SECONDS")]
        r#for: Option<u64>,
    },
    /// Hold the store's watch open and print a line for each change, as a
    /// held stream of an app does: what `follow` prints, and, with
    /// `--reader`, a line for each save another process makes.
    ///
    /// The watch is the one an app's listeners share, so a hydration or
    /// catch-up an app calls would take its stream and give it back. This
    /// process holds the store on a writer handle, so none can run meanwhile.
    /// A reader watches local saves without hydration or server
    /// contact. A writer on a never-hydrated or interrupted copy waits for
    /// hydration and prints a hint to hydrate first. When the watch
    /// fails, it prints `watch.failed` and ends with that error, since nothing
    /// in this process would start it again. Each time the server is reachable
    /// again after it was lost, or after a drain left a write undelivered,
    /// it drains the queue once where writes wait.
    Watch {
        /// Stop after this many seconds; without it, watch until
        /// interrupted.
        #[arg(long = "for", value_name = "SECONDS")]
        r#for: Option<u64>,
    },
    /// Print a line each time another process saves to the store. Opens it
    /// to read, with or without `--reader`, so watching never takes the
    /// writer's place.
    Changes {
        /// Stop after this many seconds; without it, watch until
        /// interrupted.
        #[arg(long = "for", value_name = "SECONDS")]
        r#for: Option<u64>,
    },
    /// The items and edges that changed in the copy since a cursor this
    /// command printed, and the cursor to pass next.
    ///
    /// Without `--since`, with a cursor from another store, from beyond what
    /// the copy recorded, from before a change to the types or from before
    /// a removed edge the copy no longer records, or where more than
    /// `--most` items or edges changed, it names none and answers
    /// `everything: true`: read the whole copy again. An item is named where
    /// its own content, tags, edges, pin or a queued write to it changed; one whose
    /// body links read differently only because another item changed is
    /// not. Refused `hydration_incomplete` while a hydration is part way or
    /// the copy is stale. Take the cursor before reading what it covers, and
    /// keep the earlier cursor until that read succeeds.
    Changed {
        /// A cursor an earlier run printed.
        #[arg(long, value_name = "CURSOR")]
        since: Option<String>,
        /// The most items, and the most edges, to name before answering
        /// `everything` instead.
        #[arg(long, default_value_t = 1000)]
        most: u32,
    },
    /// Read items from the local copy.
    Items {
        #[command(subcommand)]
        command: ItemsCommand,
    },
    /// Folders' settings: read from the copy, written through the folder
    /// operations.
    Folders {
        #[command(subcommand)]
        command: DeviceFoldersCommand,
    },
    /// Views and their groups, read from the local copy.
    Views {
        #[command(subcommand)]
        command: DeviceViewsCommand,
    },
    /// The tables the copy holds: which an app holds, and how each fills.
    Tables {
        #[command(subcommand)]
        command: DeviceTablesCommand,
    },
    /// A table's rows, read from the copy where it holds the table whole and
    /// from the server otherwise; `held` says which.
    Rows {
        #[command(subcommand)]
        command: DeviceRowsCommand,
    },
    /// Full-text search over the local copy, best match first.
    ///
    /// Without `--view`, while a hydration fills the copy or after one was
    /// interrupted, the search covers the items that have arrived and says
    /// it is partial. Once the server's event log no longer reaches the
    /// copy, and until a hydration has filled it again, the search covers
    /// the items the copy holds and says it is stale. Each is said on
    /// standard error, and under --json as `completeness`, `partial`,
    /// `stale` or `complete`, beside `hits`. With `--view`, a copy that is
    /// not whole is refused.
    Search {
        /// Words to look for, matched as the server matches them: all must
        /// match, the last as a prefix, and a query in double quotes is a
        /// phrase.
        #[arg(allow_hyphen_values = true)]
        query: String,
        /// A state to answer; repeat it or separate states with commas.
        /// Unset answers the active state.
        #[arg(long, value_delimiter = ',')]
        state: Vec<ItemState>,
        /// Every state, not just the active one.
        #[arg(long)]
        all_states: bool,
        /// A type identifier, with its subtypes; repeat it or separate types
        /// with commas, up to ten.
        #[arg(long = "type", value_name = "TYPE", value_delimiter = ',')]
        type_: Vec<String>,
        /// Only hits at this tier.
        #[arg(long)]
        tier: Option<Tier>,
        /// Hits must carry every tag given.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
        /// Exclusive lower bound on the item's own time, RFC 3339.
        #[arg(long = "occurred-after", value_name = "TIME")]
        occurred_after: Option<String>,
        /// Exclusive upper bound on the item's own time, RFC 3339.
        #[arg(long = "occurred-before", value_name = "TIME")]
        occurred_before: Option<String>,
        /// An expression in the server's listing grammar, answered as the
        /// server answers `filter`; a `backref` condition is refused unless the copy holds its edge type whole.
        #[arg(long, value_name = "EXPR")]
        filter: Option<String>,
        /// Only this item and what it reaches along `parent-of` edges.
        #[arg(long, value_name = "ID")]
        beneath: Option<String>,
        /// How many hits at most.
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// Only what this view's query selects; refused with a reason where
        /// the copy cannot answer the query whole.
        #[arg(long, value_name = "ID", conflicts_with_all = ["state", "all_states", "type_", "tier", "tags", "occurred_after", "occurred_before", "filter", "beneath"])]
        view: Option<String>,
    },
    /// Every queued write, the body it carries and what became of it.
    Queue,
    /// Send what the queue holds and record what came back.
    ///
    /// One pass. A write that met a network rather than an answer is left
    /// where it was, uncounted, for the next drain. A write that has met one
    /// in three drains in a row, no two more than 15 minutes apart and the
    /// first at least five minutes ago, is tested: the drain sends the write
    /// that does not depend on it and was sent least recently, one never sent
    /// first. If the server answers that write, the drain sends the tested
    /// write once more, and if that meets one again it is set aside as
    /// failing_alone and the drain carries on. If the write sent to test it
    /// meets one too, cannot be sent, or the tested write is answered,
    /// nothing is set aside. A device that drains less often than every 15
    /// minutes never sets a write aside.
    Drain,
    /// Clear the writes the server has answered.
    ///
    /// A queue nobody empties makes every later write slower. Blocked and
    /// dead writes stay, because a caller may still release them, and so does
    /// a refused write that carried content, until it is discarded.
    ///
    /// With `--id`, only the writes named are cleared, under the same rules,
    /// and every other answered write stays. An id that names no write, or
    /// one not answered, is ignored.
    Forget {
        /// A write to clear, by its queue id. Repeatable.
        #[arg(long = "id", value_name = "ID")]
        ids: Vec<String>,
    },
    /// Take a refused write out of the queue, with the content it carried.
    ///
    /// The one way a refused create, edit, metadata, extension or edge
    /// write leaves the queue. A write still waiting on it keeps it, but for
    /// a create refused onto an item its natural key names that no read has
    /// found: discarded, that create takes its item out of the copy, and the
    /// writes waiting on it are refused unsent, each kept with its content.
    /// A row write goes with every write sent in its batch.
    Discard {
        /// The refused write to discard.
        #[arg(value_name = "ID")]
        id: String,
    },
    /// Send a blocked, dead or unsent refused write again.
    ///
    /// A write blocked `awaiting_dependency` is released only by the answer
    /// to the write it waits behind, never by this command. A released write
    /// goes under a fresh idempotency key. A row write instead goes again with
    /// every write sent in its batch, as they went, under the batch's key, and
    /// an undo under its own key, unless either was blocked `key_spent`.
    Release {
        /// The queued write to release.
        #[arg(
            value_name = "ID",
            conflicts_with = "reason",
            required_unless_present = "reason"
        )]
        id: Option<String>,
        /// Release every write blocked for this reason instead of one by id.
        #[arg(long, value_name = "REASON", value_parser = blocked_reason())]
        reason: Option<marfa_core::BlockedReason>,
    },
    /// Take a write that is `dead`, or blocked `ancestor_unavailable`,
    /// `conflict_unresolved`, `failing_alone`, `instance_changed` or
    /// `record_unread`, out of the queue, and put the copy back to what the
    /// server holds.
    ///
    /// A release sends a write again on the version it already names. A write
    /// blocked `conflict_unresolved` is refused the same way each time, and
    /// one blocked `ancestor_unavailable` too, unless the credential it is
    /// sent with has come to read the snapshot it names. A `dead` write has
    /// failed five times in a way that counts. The writes held for the
    /// withdrawn write are refused unsent. A row write goes with every write
    /// sent in its batch.
    ///
    /// Prints the id of every write withdrawn. With `--json` it answers the
    /// list of those ids, which is empty where nothing was withdrawn.
    Withdraw {
        /// The queued write to withdraw.
        #[arg(value_name = "ID")]
        id: String,
    },
    /// What the local copy holds and where it came from.
    ///
    /// While a hydration fills the copy, the report also gives the items its
    /// listings have brought, `items_listed` under --json, and the items the
    /// server counted for the slice when the hydration started, where it
    /// counted them, `items_expected`. Set the first against the second to
    /// show how far it has come; the item count also holds pinned items and
    /// writes still waiting.
    ///
    /// The hydration is `never`, `in_progress`, `complete`, `stale` or
    /// `expired`. A stale copy is one the server's event log no longer
    /// reaches: it answers reads marked stale and takes writes, but not to
    /// edges, until a hydration has filled it again in place, and stays
    /// stale while that hydration runs. An expired copy refuses reads and writes until a
    /// hydration, which empties it first.
    ///
    /// `synced_at` is when the copy last finished a pull from the server
    /// without error, from this device's clock: a hydration or catch-up that
    /// completed, or a follow at the head of the event log, which records it
    /// at most every 30 seconds. A pull that fails or ends part way leaves it
    /// as it was, and a hydration that empties the copy removes it, while one
    /// that fills a stale copy in place keeps it until that hydration
    /// completes.
    Status,
    /// Read every page of the store, and refuse one SQLite cannot read
    /// store_damaged, naming it and how many writes its queue holds that the
    /// server has not taken, or that its queue cannot be read whole.
    ///
    /// It reads the whole file, so it takes longer the larger the store. It
    /// changes nothing, and is refused reading_handle while another process
    /// holds the store's writer role.
    Check,
    /// Set aside a store SQLite cannot read, and make a new one in its place
    /// that carries every write its queue lets be read.
    ///
    /// The damaged store and its logs move to `PATH.damaged-N` beside it, for
    /// the first N no file holds, and are never deleted. Each write carried
    /// keeps its id and idempotency key, its body, its base version and its
    /// verdict, and the new store keeps the server and instance the old one
    /// was built from and the bytes kept beside the store. The answer counts
    /// the writes carried that the server has not taken and the writes it
    /// could not read, names each of those by id where it can, and says
    /// whether the whole queue was found.
    ///
    /// The new store holds no copy: hydrate it, and then drain, to send what
    /// it carries; a drain before then sends nothing. Where the old store
    /// does not say which instance it was built from, each carried write is
    /// held blocked instance_changed until released, and a carried write
    /// whose record of how it is sent does not read is held blocked
    /// record_unread until released. A store that opens as it
    /// is, or a folder's store, is refused invalid. A set-aside that stopped
    /// part way is finished by running it again, and until then the store is
    /// refused store_damaged.
    #[command(name = "set-aside")]
    SetAside,
    /// The item types the copy holds, read from it alone, the ones an app
    /// declares for it, and the server's.
    Types {
        #[command(subcommand)]
        command: TypesCommand,
    },
    /// The edge types the copy holds, read from it alone, and the server's.
    #[command(name = "edge-types")]
    EdgeTypes {
        #[command(subcommand)]
        command: CatalogCommand,
    },
    /// Edges between items, each its own write.
    Edges {
        #[command(subcommand)]
        command: EdgesCommand,
    },
    /// Tags on an item, each its own write.
    Tags {
        #[command(subcommand)]
        command: TagsCommand,
    },
    /// An item's metadata, written whole.
    Metadata {
        #[command(subcommand)]
        command: MetadataCommand,
    },
    /// An item's extension namespaces, each its own write.
    Extensions {
        #[command(subcommand)]
        command: ExtensionsCommand,
    },
    /// Blobs' bytes: uploaded as queued writes, fetched when asked for and
    /// kept within a budget.
    Blobs {
        #[command(subcommand)]
        command: BlobsCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum BlobsCommand {
    /// Hold a file's bytes beside the store and queue their upload.
    Put {
        /// The file to upload.
        file: PathBuf,
        /// The MIME type to send them under; the default comes from the
        /// file's extension.
        #[arg(long)]
        mime_type: Option<String>,
    },
    /// Print where a blob's bytes are held, fetching them first where the
    /// store does not hold them yet.
    Get {
        /// The blob's hash, `sha256:<hex>`.
        hash: String,
    },
    /// Show or change how many bytes of fetched files the store keeps.
    Budget {
        /// A byte count, `keep-all` to keep every file fetched, or `default`
        /// for the larger of 2 GiB and a tenth of the volume, held to what
        /// leaves a twentieth of the volume free and never below 256 MiB.
        /// Omit it to show the budget in force. Setting one also removes
        /// files to fit it, and reports the bytes removed.
        value: Option<String>,
        /// Remove files larger than the budget, then the files read longest
        /// ago, until the budget holds, and report the bytes removed.
        #[arg(long)]
        trim: bool,
    },
    /// Fetch the files attached to items the store holds that it does not
    /// hold yet, smallest first, resuming any fetch that stopped part way.
    ///
    /// Attached files stay on the device outside the budget while the item
    /// they are attached to is held, and so does the part of one a fetch
    /// left, which this resumes. Run it after `device hydrate` and after
    /// each `device catch-up`. It waits out a server that asks for a wait of
    /// a minute or less, and stops at the first file the disk has no room
    /// for, once the server cannot be reached, or once it asks for a longer
    /// wait. A file that fails otherwise is passed over. It reports the
    /// attached files not held and why. Ctrl-C stops it between two files
    /// or during a wait.
    FetchKept,
}

#[derive(Debug, Subcommand)]
pub enum ItemsCommand {
    /// List items, newest first unless sorted otherwise.
    ///
    /// Without `--view`, while a hydration fills the copy or after one was
    /// interrupted, the list holds the items that have arrived and says it
    /// is partial. Once the server's event log no longer reaches the copy,
    /// and until a hydration has filled it again, the list holds the items
    /// the copy holds and says it is stale. Each is said on standard error,
    /// and under --json as `completeness`, `partial`, `stale` or `complete`,
    /// beside `items`. With `--view`, a copy that is not whole is refused.
    List(ListArgs),
    /// One item by id, with its properties and tags.
    ///
    /// While a hydration fills the copy, an item that has not arrived is
    /// refused `hydration_incomplete` rather than reported as not held.
    Get {
        /// The item id.
        id: String,
    },
    /// Many items by id, read from one snapshot of the copy, each once and
    /// in the order named.
    ///
    /// An id the copy does not hold is left out, and so is an item in the
    /// bin unless `--include-bin`. Under --json the answer is `items` beside
    /// `completeness`, as `items list` answers; while a hydration fills the
    /// copy it is `partial`, since an item left out may be still to arrive.
    #[command(name = "bulk-get")]
    BulkGet {
        /// The item ids.
        #[arg(required = true)]
        ids: Vec<String>,
        /// Answer items in the bin too.
        #[arg(long)]
        include_bin: bool,
    },
    /// Write a new item into the local copy and queue it for the server.
    Create(CreateArgs),
    /// Change an item in the local copy and queue the change.
    Update(UpdateArgs),
    /// Move an item to the bin locally and queue the delete.
    Delete {
        /// The item id.
        id: String,
    },
    /// Destroy an item in the bin on the server now, and take it out of the
    /// local copy. Never queued: it needs the server, a key holding
    /// `items.purge` and write on the item's type, and an item the copy holds
    /// in the bin with no write to it waiting.
    Purge {
        /// The item id.
        id: String,
        /// The version the item was read at in the bin; without it the copy's
        /// own, and an item the copy does not hold is refused.
        #[arg(long)]
        version: Option<i64>,
    },
    /// Read a page of the server's bin, newest binned first. Online only,
    /// and held nowhere in the copy.
    Bin {
        /// A type identifier; its subtypes are included.
        #[arg(long = "type")]
        type_: Option<String>,
        /// Where the page starts, as the last page's `next_cursor` named it.
        #[arg(long)]
        cursor: Option<String>,
        /// How many items at most, up to 100.
        #[arg(long, default_value_t = 50)]
        limit: u32,
    },
    /// Take an item out of the bin and queue the restore: locally where the
    /// copy holds it, and by id where it does not.
    Restore {
        /// The item id.
        id: String,
    },
    /// Move an item to another lifecycle state.
    Transition {
        /// The item id.
        id: String,
        /// The state to move it to. `revoked` is the server's alone.
        #[arg(long)]
        state: ItemState,
    },
    /// Add a file as an item of its own: its upload and a file item naming
    /// the bytes, two queued writes, and one for each tag.
    Add(AddArgs),
    /// Attach a file to an item: its upload, a file item naming the bytes,
    /// and an `attached-to` edge, three queued writes.
    ///
    /// Answers the text that embeds the file in the item's body,
    /// `![[title]]`, where the file's title names it alone among the item's
    /// attachments. Under --json the answer is one object: `upload`, `item`
    /// and `edge`, each a queued write, and `embed`, the text or null.
    Attach(AttachArgs),
    /// The links and embeds of files in an item's body, read from the local
    /// copy: each with the item it names, or why it names none yet.
    Links {
        /// The item id.
        id: String,
    },
    /// The links and embeds of files in the bodies of many items, read
    /// against one catalog, by item id: what `items links` answers for
    /// each. An item the copy does not hold, one in the bin and one whose
    /// properties cannot be read are left out.
    #[command(name = "bulk-links")]
    BulkLinks {
        /// The item ids.
        #[arg(required = true)]
        ids: Vec<String>,
    },
    /// The `[[links]]` in a text, in order and repeats included, each with
    /// its name, heading or row (`#^row`) and alias and where each sits in the text, counted
    /// in UTF-16 code units. A link in code or a comment, an embed, and a
    /// `[[` followed by a line break or another `[[` before its `]]` are not
    /// links. Reads no copy.
    #[command(name = "link-parts")]
    LinkParts {
        /// The text.
        #[arg(conflicts_with = "file", required_unless_present = "file")]
        text: Option<String>,
        /// Read the text from a file, or `-` for stdin.
        #[arg(long, value_name = "PATH")]
        file: Option<PathBuf>,
    },
    /// What each link could name, read from the local copy: every item
    /// outside the bin whose id, title or file path its name answers to,
    /// without regard to case or Unicode form, and whether it is `bound`,
    /// `ambiguous` or `unresolved`. An item the copy does not hold is not
    /// listed.
    #[command(name = "link-candidates")]
    LinkCandidates {
        /// The text between each link's brackets, such as `Plan#Goals|the
        /// plan`.
        #[arg(required = true)]
        targets: Vec<String>,
        /// Answer each as a link in this item's body would bind, by the
        /// edges the item already has.
        #[arg(long, value_name = "ID")]
        item: Option<String>,
    },
    /// The text that embeds a file item in an item's body, which reads back
    /// as the item's `references` edge to the file.
    Embed {
        /// The item whose body the embed goes in.
        id: String,
        /// The file item to embed.
        file: String,
    },
    /// The thumbnail an item carries, read from the local copy with no
    /// request: its MIME type and size, and its bytes written to `--out`.
    Thumbnail {
        /// The item id.
        id: String,
        /// Where to write the image's bytes.
        #[arg(long, value_name = "FILE")]
        out: Option<PathBuf>,
    },
}

#[derive(Debug, Args)]
pub struct AddArgs {
    /// The file to add.
    pub file: PathBuf,
    /// The MIME type; the default comes from the file's extension.
    #[arg(long)]
    pub mime_type: Option<String>,
    /// The file item's title; the default is the file's name.
    #[arg(long)]
    pub title: Option<String>,
    /// The file item's type; the default comes from the MIME type.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// A tag, repeatable. Each is queued as a write of its own.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// The tier to write the file item at.
    #[arg(long)]
    pub tier: Option<Tier>,
}

#[derive(Debug, Args)]
pub struct AttachArgs {
    /// The item to attach the file to.
    pub id: String,
    /// The file to attach.
    pub file: PathBuf,
    /// The MIME type; the default comes from the file's extension.
    #[arg(long)]
    pub mime_type: Option<String>,
    /// The file item's title; the default is the file's name.
    #[arg(long)]
    pub title: Option<String>,
    /// The file item's type; the default comes from the MIME type.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// The tier to write the file item at.
    #[arg(long)]
    pub tier: Option<Tier>,
}

#[derive(Debug, Subcommand)]
pub enum EdgesCommand {
    /// One edge by id.
    Get {
        /// The edge id.
        id: String,
    },
    /// Many edges by id, each once and in the order named; an id the copy
    /// does not hold is left out.
    #[command(name = "bulk-get")]
    BulkGet {
        /// The edge ids.
        #[arg(required = true)]
        ids: Vec<String>,
    },
    /// The edges the copy holds from one item.
    List {
        /// The item the edges start from.
        item: String,
    },
    /// The edges the copy holds to one item.
    To {
        /// The item the edges point at.
        item: String,
    },
    /// Link two items, and queue the edge.
    Create {
        /// The item the edge starts from.
        #[arg(long = "from", value_name = "ID")]
        source: String,
        /// The item the edge points at.
        #[arg(long = "to", value_name = "ID")]
        target: String,
        /// The edge type.
        #[arg(long = "type", value_name = "TYPE")]
        type_: String,
        /// The edge's properties, as a JSON object.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        properties: String,
        /// The id to mint it under. Omitted, the device mints one.
        #[arg(long)]
        id: Option<String>,
    },
    /// Say whether `edges create` would refuse an edge now, from what the copy holds, and queue nothing. The server still judges an edge the copy finds nothing against.
    Check {
        /// The item the edge starts from.
        #[arg(long = "from", value_name = "ID")]
        source: String,
        /// The item the edge points at.
        #[arg(long = "to", value_name = "ID")]
        target: String,
        /// The edge type.
        #[arg(long = "type", value_name = "TYPE")]
        type_: String,
        /// The edge's properties, as a JSON object.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        properties: String,
        /// The id it would be minted under.
        #[arg(long)]
        id: Option<String>,
    },
    /// Say whether `edges update` would refuse moving one end of an edge now, from what the copy holds, and queue nothing. A move onto the end the edge holds already changes nothing. The server still judges a move the copy finds nothing against.
    #[command(name = "check-move")]
    #[command(group(clap::ArgGroup::new("end").required(true).args(["source", "target"])))]
    CheckMove {
        /// The edge id.
        id: String,
        /// Move the edge to this source.
        #[arg(long = "from", value_name = "ID")]
        source: Option<String>,
        /// Move the edge to this target.
        #[arg(long = "to", value_name = "ID")]
        target: Option<String>,
    },
    /// Change an edge's properties, or move one of its ends. An edit that names no property and no new end queues no write.
    Update {
        /// The edge id.
        id: String,
        /// The properties to write, as a JSON object. Whole values.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        properties: String,
        /// The version the edit was based on. Required, as on an item.
        #[arg(long)]
        version: Option<i64>,
        /// Move the edge to this source, where each target holds one of its type.
        #[arg(long = "from", value_name = "ID")]
        source: Option<String>,
        /// Move the edge to this target, where each source holds one of its type.
        #[arg(long = "to", value_name = "ID")]
        target: Option<String>,
    },
    /// Drop an edge locally and queue the delete.
    Delete {
        /// The edge id.
        id: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum TypesCommand {
    /// Every one the copy holds, by id.
    List,
    /// Every one the server holds, read from it now, so a slice can be chosen
    /// before a first hydration. The copy is left as it is.
    Served,
    /// One by id; a type inherits the fields of the types above it.
    Get {
        /// The id, such as `core.note`.
        id: String,
    },
    /// Declare the types this app saves, so a copy with no server checks what
    /// it queues against them and a hydration registers the ones the
    /// instance lacks, where the key may.
    ///
    /// Marfa's own types need no declaring. The call is the app's whole set,
    /// so it replaces every earlier declaration, and a set that names one id
    /// twice is refused `invalid`.
    Declare {
        /// A type definition, or an array of them, as JSON.
        #[arg(
            long,
            value_name = "JSON",
            conflicts_with = "file",
            required_unless_present = "file"
        )]
        definitions: Option<String>,
        /// A file holding the same.
        #[arg(long, value_name = "PATH")]
        file: Option<PathBuf>,
    },
    /// The declarations this copy holds, with the empty `fields` and the
    /// `version` a registration needs filled in.
    Declared,
}

#[derive(Debug, Subcommand)]
pub enum CatalogCommand {
    /// Every one the copy holds, by id.
    List,
    /// Every one the server holds, read from it now, so a slice can be chosen
    /// before a first hydration. The copy is left as it is.
    Served,
    /// One by id; a type inherits the fields of the types above it.
    Get {
        /// The id, such as `core.note` or `parent-of`.
        id: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum TagsCommand {
    /// Put one tag on an item.
    Add {
        /// The item id.
        item: String,
        /// The tag.
        tag: String,
    },
    /// Take one tag off an item.
    Remove {
        /// The item id.
        item: String,
        /// The tag.
        tag: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum MetadataCommand {
    /// Write the item's tags whole, dropping any not named.
    Replace {
        /// The item id.
        item: String,
        /// A tag, repeatable.
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum ExtensionsCommand {
    /// Write one extension namespace.
    Write {
        /// The item id.
        item: String,
        /// The extension namespace.
        namespace: String,
        /// The namespace's contents, as a JSON object.
        #[arg(long, value_name = "JSON", default_value = "{}")]
        body: String,
    },
    /// Remove one extension namespace.
    Delete {
        /// The item id.
        item: String,
        /// The extension namespace.
        namespace: String,
    },
}

#[derive(Debug, Args)]
pub struct CreateArgs {
    /// The type the item is.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: String,
    /// The properties, as a JSON object.
    #[arg(long, value_name = "JSON")]
    pub properties: String,
    /// A tag, repeatable. Each is queued as a write of its own.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// The tier to write it at; the default is the tier of the held item its
    /// natural key names, else the slice's tier, or the library from a slice
    /// of both or before a first hydration. A create carrying `--source-id`
    /// goes with that tier only where a lookup answers that no item on the
    /// server holds its natural key, and otherwise with none, which keeps an
    /// item's tier as it stands.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// The state to create it in; the default is active.
    #[arg(long)]
    pub state: Option<ItemState>,
    /// Where it was captured: the latitude, in degrees. Needs `--capture-longitude`.
    #[arg(
        long,
        value_name = "DEGREES",
        requires = "capture_longitude",
        allow_hyphen_values = true
    )]
    pub capture_latitude: Option<f64>,
    /// Where it was captured: the longitude, in degrees. Needs `--capture-latitude`.
    #[arg(
        long,
        value_name = "DEGREES",
        requires = "capture_latitude",
        allow_hyphen_values = true
    )]
    pub capture_longitude: Option<f64>,
    /// Edges to make with it, as a JSON object of edge type to a list of
    /// target ids. Queued and sent as one write with the item: if the server
    /// refuses any, it makes none of them and the item stays in the queue as
    /// refused.
    #[arg(long, value_name = "JSON")]
    pub edges: Option<String>,
    /// The source to stamp it with.
    #[arg(long)]
    pub source: Option<String>,
    /// The id this item has in the system it came from.
    #[arg(long)]
    pub source_id: Option<String>,
    /// The item's own time, RFC 3339. Defaults to now.
    #[arg(long)]
    pub occurred_at: Option<String>,
    /// The id to mint it under. Omitted, the device mints one.
    #[arg(long)]
    pub id: Option<String>,
    /// The version this create is conditional on, where its natural key
    /// resolves an item the server already holds.
    #[arg(long)]
    pub version: Option<i64>,
}

#[derive(Debug, Args)]
pub struct UpdateArgs {
    /// The item id.
    pub id: String,
    /// The properties to write, as a JSON object. Whole values. Required
    /// unless `--clear-property` is given.
    #[arg(
        long,
        value_name = "JSON",
        required_unless_present = "clear_properties"
    )]
    pub properties: Option<String>,
    /// A property to remove from the item, leaving every other as it is.
    /// Repeat it to remove more than one.
    #[arg(long = "clear-property", value_name = "NAME")]
    pub clear_properties: Vec<String>,
    /// The version the edit was based on. Required: the device refuses an
    /// update that names no version, as the server does.
    #[arg(long)]
    pub version: Option<i64>,
    /// The natural key to move the item to. The server refuses one another
    /// item already holds, so a rename does not take a name off a note.
    #[arg(long, value_name = "KEY")]
    pub source_id: Option<String>,
    /// The version is one read before the version the copy holds now, and
    /// the server merges the edit against it rather than taking it as newer
    /// than what came in since.
    #[arg(long)]
    pub as_read: bool,
    /// The type to move the item to. The server holds its properties to the
    /// type it enters.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// The tier to move the item to.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// The properties are the item's whole properties: one they leave out is
    /// cleared rather than kept. Requires `--properties`.
    #[arg(long, requires = "properties")]
    pub replace: bool,
    /// The item's own time, RFC 3339.
    #[arg(long, value_name = "TIME", conflicts_with = "clear_occurred_at")]
    pub occurred_at: Option<String>,
    /// Give the item no time of its own again, so its own time is its
    /// creation time.
    #[arg(long)]
    pub clear_occurred_at: bool,
}

#[derive(Debug, Args)]
pub struct ListArgs {
    /// A type identifier, with its subtypes; repeat it or separate types
    /// with commas, up to ten.
    #[arg(long = "type", value_name = "TYPE", value_delimiter = ',')]
    pub type_: Vec<String>,
    /// A state to answer; repeat it or separate states with commas. Unset
    /// answers the active state.
    #[arg(long, value_delimiter = ',')]
    pub state: Vec<ItemState>,
    /// Every state, not just the active one.
    #[arg(long)]
    pub all_states: bool,
    /// Only items at this tier.
    #[arg(long)]
    pub tier: Option<Tier>,
    /// Items must carry every tag given.
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    /// Exclusive lower bound on the item's own time, RFC 3339.
    #[arg(long = "occurred-after", value_name = "TIME")]
    pub occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time, RFC 3339.
    #[arg(long = "occurred-before", value_name = "TIME")]
    pub occurred_before: Option<String>,
    /// An expression in the server's listing grammar, answered as the
    /// server answers `filter`; a `backref` condition is refused unless the copy holds its edge type whole.
    #[arg(long, value_name = "EXPR")]
    pub filter: Option<String>,
    /// Only this item and what it reaches along `parent-of` edges.
    #[arg(long, value_name = "ID")]
    pub beneath: Option<String>,
    /// Only the items stamped with this source.
    #[arg(long)]
    pub source: Option<String>,
    /// Inclusive lower bound on the time the item was last changed, RFC 3339.
    /// Orders the list by that time, then id, oldest first; another `--sort`
    /// or `--direction` is refused with it.
    #[arg(long = "updated-after", value_name = "TIME")]
    pub updated_after: Option<String>,
    /// Exclusive upper bound on the time the item was last changed, RFC 3339.
    #[arg(long = "updated-before", value_name = "TIME")]
    pub updated_before: Option<String>,
    /// The field to order by: `created-at` (the default), `updated-at`,
    /// `occurred-at` or `properties.<name>`. A property orders numbers and
    /// booleans first, then text, and items without it last; ties go by id.
    #[arg(long, value_parser = parse_sort_field)]
    pub sort: Option<marfa_core::SortField>,
    /// Descending (the default) or ascending.
    #[arg(long)]
    pub direction: Option<SortDirection>,
    /// How many items at most.
    #[arg(long)]
    pub limit: Option<u32>,
    /// How many items to skip first.
    #[arg(long)]
    pub offset: Option<u32>,
    /// Only what this view selects, in the view's own sort; refused with a
    /// reason where the copy cannot answer the query whole.
    #[arg(long, value_name = "ID", conflicts_with_all = VIEW_SCOPED)]
    pub view: Option<String>,
}

const VIEW_SCOPED: [&str; 14] = [
    "type_",
    "state",
    "all_states",
    "tier",
    "tags",
    "occurred_after",
    "occurred_before",
    "source",
    "updated_after",
    "updated_before",
    "filter",
    "beneath",
    "sort",
    "direction",
];

#[derive(Debug, Subcommand)]
pub enum DeviceTablesCommand {
    /// Hold a table of each item the copy holds whose type TYPE names, as a
    /// slice names a type, and fill it now: whole up to 100,000 rows and
    /// 64 MiB, and read from the server past that.
    Hold {
        /// The type, as a slice names one: an id, `<root>.*`, or `*`.
        #[arg(value_name = "TYPE")]
        type_id: String,
        /// The table's name.
        table: String,
    },
    /// Stop holding a table, removing the rows the copy holds of it.
    #[command(name = "let-go")]
    LetGo {
        /// The type, as it was held.
        #[arg(value_name = "TYPE")]
        type_id: String,
        /// The table's name.
        table: String,
    },
    /// The tables held, and how far each item's table has filled.
    Held,
    /// Fill each table held that is not whole.
    Fill,
}

#[derive(Debug, Subcommand)]
pub enum DeviceRowsCommand {
    /// One page of a table's rows, as `marfa rows list` answers it.
    List(crate::commands::rows::ListArgs),
    /// Queue a batch of `put`, `patch` and `delete` operations for a table,
    /// all of them or none, as `marfa rows write` takes it. Where the copy
    /// holds the table whole, its rows show the batch at once.
    Write {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        #[command(flatten)]
        body: crate::commands::BodySource,
    },
    /// Queue an undo of a batch, as `marfa rows undo` sends it. The rows it
    /// puts back reach the copy with its `rows.changed`.
    Undo {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        /// The batch id, as a write's answer names it.
        batch: String,
    },
    /// One row of a table.
    Get {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        /// The row id.
        row: String,
    },
    /// How many rows a filter selects, and the total of each column that
    /// names `adds_up`.
    Totals {
        /// The item id.
        item: String,
        /// The table name.
        table: String,
        /// Only the rows this expression matches, in the server's filter
        /// grammar, where `values.<column>` names a column.
        #[arg(long)]
        filter: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum DeviceViewsCommand {
    /// List the views held in the copy.
    List,
    /// Read a view's settings from the copy.
    Get {
        /// The view's `system.view` id.
        id: String,
    },
    /// List a view's groups and the item count of each.
    Groups {
        /// The view's `system.view` id.
        id: String,
        /// An IANA time zone for date buckets; otherwise use the device's zone.
        #[arg(long, value_name = "ZONE")]
        time_zone: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum DeviceFoldersCommand {
    /// Create a folder's settings through the folder operations, at once and never
    /// queued; settings no folder follows are refused before they are sent.
    Create(crate::commands::folders::CreateArgs),
    /// Change a folder's settings through the folder operations, at once, each
    /// named one replaced whole.
    /// Omitted settings stay. Every accepted change removes stored properties
    /// the current folder type does not declare.
    Change(crate::commands::folders::ChangeArgs),
    /// Retire a folder's settings through the folder operations, at once. A
    /// revoked folder does not change.
    Revoke {
        /// The folder's `system.folder` id.
        id: String,
        #[command(flatten)]
        idempotency: crate::commands::items::IdempotencyArgs,
    },
    /// A folder's settings as the copy holds them.
    Get {
        /// The folder's `system.folder` id.
        id: String,
    },
}

/// A store found damaged part way through a read is named, with what its
/// queue holds, where the store can be read to say so.
pub fn run(args: DeviceArgs, named: &Named, json: bool) -> Result<Exit, CliError> {
    let db = args.db.clone();
    run_on(args, named, json).map_err(|error| match (error, db) {
        (
            CliError::Core(marfa_core::CoreError::StoreDamaged {
                path,
                reason,
                unsent,
            }),
            Some(db),
        ) if path.is_empty() => match Core::check_store(&db) {
            Err(named @ marfa_core::CoreError::StoreDamaged { .. }) => CliError::Core(named),
            _ => CliError::Core(marfa_core::CoreError::StoreDamaged {
                path,
                reason,
                unsent,
            }),
        },
        (error, _) => error,
    })
}

fn run_on(args: DeviceArgs, named: &Named, json: bool) -> Result<Exit, CliError> {
    let store = Store {
        db: args.db,
        reader: args.reader,
        makes: matches!(
            args.command,
            DeviceCommand::Hydrate { .. } | DeviceCommand::Status
        ),
    };
    match args.command {
        DeviceCommand::Hydrate {
            types,
            tier,
            edge_types,
            in_place_only,
        } => {
            stop_on_interrupt();
            let core = store.open_with_server(named)?;
            let report = if in_place_only {
                core.hydrate_in_place_only(&types, tier.into(), &edge_types, stop_after(None))?
            } else {
                core.hydrate_until(&types, tier.into(), &edge_types, stop_after(None))?
            };
            output::report(&report, json, || {
                let whole = if report.edge_types.is_empty() {
                    String::new()
                } else {
                    format!(", {} held whole", report.edge_types.join(","))
                };
                let pages = if report.resumed {
                    format!("{} page(s), {} in all", report.pages, report.pages_total)
                } else {
                    format!("{} page(s)", report.pages)
                };
                let mut line = format!(
                    "hydrated {} item(s) and {} edge(s) of {} at {}{whole} in {pages}; cursor {}",
                    report.items,
                    report.edges,
                    report.types.join(","),
                    report.tier,
                    report.cursor
                );
                if report.resumed {
                    line.push_str("\nresumed the interrupted hydration from the page it had reached");
                }
                if report.in_place {
                    line.push_str(
                        "\nfilled the copy again over the items it held, taking out the ones the server no longer has",
                    );
                }
                if let Some(restart) = report.restarted {
                    line.push_str(&format!(
                        "\nstarted again from the first page: {} ({})",
                        restart.says(),
                        restart.as_str()
                    ));
                }
                if !report.registered_types.is_empty() {
                    line.push_str(&format!(
                        "\nregistered {} on the server",
                        report.registered_types.join(",")
                    ));
                }
                for held in &report.unregistered_types {
                    line.push_str(&format!(
                        "\nnot registered: {} ({}): {}",
                        held.id, held.code, held.message
                    ));
                }
                if !report.replaced_types.is_empty() {
                    line.push_str(&format!(
                        "\nreplaced {} on the server",
                        report.replaced_types.join(",")
                    ));
                }
                for held in &report.unreplaced_types {
                    line.push_str(&format!(
                        "\nnot replaced: {} ({}): {}",
                        held.id, held.code, held.message
                    ));
                }
                line
            })
        }
        DeviceCommand::Pin { id } => {
            let was_pinned = store.open_with_server(named)?.pin(&id)?;
            output::report(
                &serde_json::json!({ "id": id, "pinned": true, "was_pinned": was_pinned }),
                json,
                || {
                    if was_pinned {
                        format!("{id} was pinned already, and is read again")
                    } else {
                        format!("pinned {id}")
                    }
                },
            )
        }
        DeviceCommand::Unpin { id } => {
            let was_pinned = store.open(None)?.unpin(&id)?;
            output::report(
                &serde_json::json!({ "id": id, "pinned": false, "was_pinned": was_pinned }),
                json,
                || {
                    if was_pinned {
                        format!("unpinned {id}")
                    } else {
                        format!("{id} was not pinned")
                    }
                },
            )
        }
        DeviceCommand::Follow { r#for } => {
            stop_on_interrupt();
            let core = store.open_with_server(named)?;
            let stop = stop_after(r#for);
            if !json
                && matches!(
                    core.status()?.hydration,
                    marfa_core::Hydration::Never | marfa_core::Hydration::InProgress
                )
            {
                eprintln!(
                    "this copy is not hydrated, so the follow waits for a hydration; this process holds the store until it ends, so run `device hydrate` first"
                );
            }
            let mut unwritten: Option<CliError> = None;
            let report = core.follow(stop, false, |change| {
                if unwritten.is_some() {
                    return;
                }
                let written = output::line_of(change, json, || change_line(change));
                if let Err(error) = written {
                    unwritten = Some(error);
                    stop.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            })?;
            if let Some(error) = unwritten {
                return Err(error);
            }
            output::line_of(&report, json, || {
                let failed = match (&report.last_failure, report.failed_opens) {
                    (Some(reason), count) => format!(
                        "; {count} stream(s) could not be opened and {} table read(s) failed, last: {reason}",
                        report.tables_failed
                    ),
                    (None, _) => String::new(),
                };
                let cursor = if report.cursor.is_empty() {
                    "no cursor, as it stopped before reading one".to_string()
                } else {
                    format!("cursor {}", report.cursor)
                };
                format!(
                    "applied {} event(s), skipped {}{}; {cursor}; {} reconnect(s){failed}",
                    report.applied,
                    report.skipped,
                    read_only_said(report.read_only_held),
                    report.reconnects
                )
            })
        }
        DeviceCommand::Changes { r#for } => {
            let core = Arc::new(
                Store {
                    reader: true,
                    ..store
                }
                .open(None)?,
            );
            // Once the store is open, so that an interrupt before then ends
            // the command as it always did.
            stop_on_interrupt();
            let stop = stop_after(r#for);
            // The line is printed once the watch is joined, which read the
            // version it tells saves after: a save made on reading the line is
            // told.
            watching(&core, stop, json, true, || {
                let seen = core.data_version()?;
                if json {
                    output::line_of(
                        &serde_json::json!({ "watching": true, "data_version": seen }),
                        json,
                        String::new,
                    )
                } else {
                    match r#for {
                        Some(seconds) => eprintln!("watching for saves for {seconds}s"),
                        None => eprintln!("watching for saves (interrupt to stop)"),
                    }
                    Ok(())
                }
            })?;
            crate::interrupt::ended_by_interrupt();
            Ok(())
        }
        DeviceCommand::Watch { r#for } => {
            stop_on_interrupt();
            let core = Arc::new(store.open_with_server(named)?);
            let stop = stop_after(r#for);
            if !json
                && core.handle() == marfa_core::Handle::Writer
                && matches!(
                    core.status()?.hydration,
                    marfa_core::Hydration::Never | marfa_core::Hydration::InProgress
                )
            {
                eprintln!(
                    "this copy is not hydrated, so the watch waits for a hydration; this process holds the store until it ends, so run `device hydrate` first"
                );
            }
            watching(&core, stop, json, false, || Ok(()))?;
            crate::interrupt::ended_by_interrupt();
            Ok(())
        }
        DeviceCommand::CatchUp => {
            stop_on_interrupt();
            let core = store.open_with_server(named)?;
            let report = core.catch_up_until(stop_after(None))?;
            output::report(&report, json, || {
                format!(
                    "applied {} event(s), skipped {}{}; cursor {}{}",
                    report.applied,
                    report.skipped,
                    read_only_said(report.read_only_held),
                    report.cursor,
                    if report.catalog_changed {
                        "; the catalog changed"
                    } else {
                        ""
                    },
                )
            })
        }
        DeviceCommand::Items {
            command:
                ItemsCommand::Bin {
                    type_,
                    cursor,
                    limit,
                },
        } => {
            let page = store
                .open_with_server(named)?
                .bin(type_.as_deref(), cursor.as_deref(), limit)?;
            let (items, shown): (Vec<_>, Vec<_>) = page.items.into_iter().unzip();
            if json {
                output::report(
                    &serde_json::json!({ "data": items, "next_cursor": page.next_cursor }),
                    true,
                    String::new,
                )
            } else {
                output::item_lines(&items, &shown)
            }
        }
        DeviceCommand::Items {
            command: ItemsCommand::LinkParts { text, file },
        } => {
            let text = match (text, file) {
                (Some(text), _) => text,
                (None, Some(file)) => crate::commands::read_text(&file)?,
                // clap refuses this; reached only if the argument rules drift.
                (None, None) => {
                    return Err(CliError::Invalid(
                        "a text is needed: TEXT, or --file PATH".into(),
                    ));
                }
            };
            let parts = marfa_core::link_parts(&text);
            output::report(&parts, json, || output::link_parts(&parts))
        }
        DeviceCommand::Items {
            command: ItemsCommand::Purge { id, version },
        } => {
            store.open_with_server(named)?.purge_item(&id, version)?;
            output::report(
                &serde_json::json!({ "id": id, "purged": true }),
                json,
                || format!("purged {id}"),
            )
        }
        DeviceCommand::Changed { since, most } => {
            let changes = store.open(None)?.changes_since(since.as_deref(), most)?;
            output::report(&changes, json, || changed_lines(&changes))
        }
        DeviceCommand::Items { command } => {
            let core = store.open(None)?;
            match command {
                ItemsCommand::List(args) => {
                    if let Some(view) = &args.view {
                        return output::listing(
                            core.list_in_view(view, args.limit, args.offset)?,
                            json,
                        )
                        .map(|()| Exit::Done);
                    }
                    let filters = ListFilters {
                        types: given(args.type_),
                        states: given(args.state.into_iter().map(Into::into).collect()),
                        all_states: args.all_states,
                        tier: args.tier.map(Into::into),
                        tags: args.tags,
                        occurred_after: args.occurred_after,
                        occurred_before: args.occurred_before,
                        source: args.source,
                        updated_after: args.updated_after,
                        updated_before: args.updated_before,
                        filter: args.filter,
                        beneath: args.beneath,
                        limit: args.limit,
                        offset: args.offset,
                    };
                    let sort = Sort::named(args.sort, args.direction.map(Into::into), &filters);
                    output::listing(core.list_shown(&filters, sort)?, json)
                }
                ItemsCommand::Get { id } => match core.get_shown(&id)? {
                    Some((item, shown)) => output::item(&item, &shown, json),
                    None => Err(CliError::not_held(&id)),
                },
                ItemsCommand::BulkGet { ids, include_bin } => {
                    output::listing(core.get_items_shown(&ids, include_bin)?, json)
                }
                ItemsCommand::Create(args) => {
                    let draft = Draft {
                        r#type: args.type_,
                        id: args.id,
                        properties: item_properties(&args.properties)?,
                        tags: args.tags,
                        tier: args.tier.map(Into::into),
                        state: args.state.map(Into::into),
                        source: args.source,
                        source_id: args.source_id,
                        occurred_at: args.occurred_at,
                        capture_latitude: args.capture_latitude,
                        capture_longitude: args.capture_longitude,
                        edges: match &args.edges {
                            Some(text) => edges(text)?,
                            None => Default::default(),
                        },
                        base_version: args.version,
                    };
                    output::queued_one(&core.create_item(&draft)?, json)
                }
                ItemsCommand::Update(args) => {
                    let edit = Edit {
                        properties: args
                            .properties
                            .as_deref()
                            .map(item_properties)
                            .transpose()?
                            .unwrap_or_default(),
                        base_version: args.version,
                        source_id: args.source_id,
                        r#type: args.type_,
                        tier: args.tier.map(Into::into),
                        occurred_at: args.occurred_at,
                        clear_occurred_at: args.clear_occurred_at,
                        replace_properties: args.replace,
                        clear_properties: args.clear_properties,
                    };
                    let queued = if args.as_read {
                        core.update_item_as_read(&args.id, &edit)?
                    } else {
                        core.update_item(&args.id, &edit)?
                    };
                    output::queued_one(&queued, json)
                }
                ItemsCommand::Delete { id } => output::queued_one(&core.delete_item(&id)?, json),
                ItemsCommand::Purge { .. } | ItemsCommand::Bin { .. } => {
                    unreachable!("answered above, with the server")
                }
                ItemsCommand::LinkParts { .. } => unreachable!("answered above, with no copy"),
                ItemsCommand::Restore { id } => output::queued_one(&core.restore_item(&id)?, json),
                ItemsCommand::Transition { id, state } => {
                    output::queued_one(&core.transition_item(&id, state.into())?, json)
                }
                ItemsCommand::Add(args) => {
                    let attachment = Attachment {
                        mime_type: args.mime_type,
                        title: args.title,
                        r#type: args.type_,
                        tier: args.tier.map(Into::into),
                    };
                    let added = core.add_file(&args.file, &attachment, &args.tags)?;
                    output::queued(
                        &[added.upload, added.item],
                        &core.queue()?,
                        &core.pending_landings()?,
                        json,
                    )
                }
                ItemsCommand::Attach(args) => {
                    let attachment = Attachment {
                        mime_type: args.mime_type,
                        title: args.title,
                        r#type: args.type_,
                        tier: args.tier.map(Into::into),
                    };
                    let attached = core.attach(&args.id, &args.file, &attachment)?;
                    if json {
                        return output::report(&attached, json, String::new).map(|()| Exit::Done);
                    }
                    output::queued(
                        &[attached.upload, attached.item, attached.edge],
                        &core.queue()?,
                        &core.pending_landings()?,
                        json,
                    )?;
                    if let Some(embed) = &attached.embed {
                        println!("embed it in the item's body with {embed}");
                    }
                    Ok(())
                }
                ItemsCommand::Links { id } => {
                    let links = core.body_links(&id)?;
                    output::report(&links, json, || output::body_links(&links))
                }
                ItemsCommand::BulkLinks { ids } => {
                    let links = core.body_links_of(&ids)?;
                    output::report(&links, json, || {
                        ids.iter()
                            .filter_map(|id| {
                                links
                                    .get(id)
                                    .map(|links| format!("{id}\n{}", output::body_links(links)))
                            })
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    })
                }
                ItemsCommand::LinkCandidates { targets, item } => {
                    let answers = core.link_candidates(item.as_deref(), &targets)?;
                    output::report(&answers, json, || output::link_candidates(&answers))
                }
                ItemsCommand::Embed { id, file } => {
                    let text = core.embed_text(&id, &file)?;
                    output::report(&serde_json::json!({ "embed": text }), json, || text)
                }
                ItemsCommand::Thumbnail { id, out } => {
                    if core.get(&id)?.is_none() {
                        return Err(CliError::not_held(&id));
                    }
                    let Some(thumbnail) = core.thumbnail(&id)? else {
                        return output::report(
                            &serde_json::json!({ "id": id, "thumbnail": null }),
                            json,
                            || format!("{id} carries no thumbnail"),
                        ).map(|()| Exit::Done);
                    };
                    if let Some(path) = &out {
                        std::fs::write(path, &thumbnail.bytes)?;
                    }
                    output::report(
                        &serde_json::json!({
                            "id": id,
                            "thumbnail": {
                                "mime_type": thumbnail.mime_type,
                                "size_bytes": thumbnail.bytes.len(),
                                "path": out,
                            }
                        }),
                        json,
                        || {
                            format!(
                                "{} of {} bytes{}",
                                thumbnail.mime_type,
                                thumbnail.bytes.len(),
                                out.as_ref()
                                    .map(|path| format!(", written to {}", path.display()))
                                    .unwrap_or_default()
                            )
                        },
                    )
                }
            }
        }
        DeviceCommand::Blobs { command } => match command {
            BlobsCommand::Put { file, mime_type } => output::queued_one(
                &store.open(None)?.put_blob(&file, mime_type.as_deref())?,
                json,
            ),
            BlobsCommand::Get { hash } => {
                // No server is required: held bytes need none, and without
                // one a missing blob is absent rather than a usage error.
                let held = store.open(named.session_if_named()?)?.blob(&hash)?;
                let path = held.path();
                output::report(
                    &serde_json::json!({ "hash": hash, "path": path }),
                    json,
                    || path.display().to_string(),
                )
            }
            BlobsCommand::Budget { value, trim } => {
                let core = store.open(None)?;
                let mut taken = match value {
                    Some(value) => Some(core.set_file_budget(parse_file_budget(&value)?)?),
                    None => None,
                };
                if trim {
                    taken = Some(taken.unwrap_or(0) + core.trim_files()?);
                }
                let cache = core.file_cache()?;
                output::report(
                    &serde_json::json!({ "file_cache": cache, "trimmed_bytes": taken }),
                    json,
                    || {
                        let mut text = file_cache_text(&cache);
                        if let Some(taken) = taken {
                            text.push_str(&format!("\ntrimmed {taken} byte(s)"));
                        }
                        text
                    },
                )
            }
            BlobsCommand::FetchKept => {
                stop_on_interrupt();
                let core = store.open_with_server(named)?;
                let fetched = core.fetch_kept_until(stop_after(None))?;
                output::report(&fetched, json, || {
                    let mut text = format!(
                        "fetched {} attached file(s), {} byte(s)",
                        fetched.fetched, fetched.fetched_bytes
                    );
                    if let Some(attachments) = &fetched.attachments {
                        text.push('\n');
                        text.push_str(&attachments_text(attachments));
                    }
                    text
                })
            }
        },
        DeviceCommand::Search {
            query,
            state,
            all_states,
            type_,
            tier,
            tags,
            occurred_after,
            occurred_before,
            filter,
            beneath,
            limit,
            view,
        } => {
            if let Some(view) = view {
                return output::found(
                    store.open(None)?.search_in_view(&query, &view, limit)?,
                    json,
                )
                .map(|()| Exit::Done);
            }
            let filters = SearchFilters {
                states: given(state.into_iter().map(Into::into).collect()),
                all_states,
                types: given(type_),
                tier: tier.map(Into::into),
                tags,
                occurred_after,
                occurred_before,
                filter,
                beneath,
            };
            let core = store.open(None)?;
            output::found(core.search_shown(&query, &filters, limit)?, json)
        }
        DeviceCommand::Tables { command } => match command {
            DeviceTablesCommand::Hold { type_id, table } => {
                let core = store.open_with_server(named)?;
                let stop = crate::interrupt::stop();
                let held = core.hold_table_until(&type_id, &table, stop)?;
                output::report(&held, json, || {
                    let what = format!("{type_id} {table}");
                    match &held.fill {
                        Some(fill) => format!("holding {what}; {}", fill_line(fill)),
                        None => format!("holding {what}; it fills with the stream"),
                    }
                })
            }
            DeviceTablesCommand::LetGo { type_id, table } => {
                let was_held = store.open(None)?.let_go_table(&type_id, &table)?;
                output::report(
                    &serde_json::json!({ "type": type_id, "table": table, "was_held": was_held }),
                    json,
                    || match was_held {
                        true => format!("let go of {type_id} {table}"),
                        false => format!("{type_id} {table} was not held"),
                    },
                )
            }
            DeviceTablesCommand::Held => {
                let held = store.open(None)?.held_tables()?;
                output::report(&held, json, || {
                    held.tables
                        .iter()
                        .map(|table| {
                            format!("{} {}: {}, {} row(s)", table.item, table.table, table.state, table.rows)
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
            }
            DeviceTablesCommand::Fill => {
                let core = store.open_with_server(named)?;
                let stop = crate::interrupt::stop();
                let fill = core.fill_tables(stop)?;
                output::report(&fill, json, || fill_line(&fill))
            }
        },
        DeviceCommand::Rows {
            command: DeviceRowsCommand::Write { item, table, body },
        } => {
            let core = store.open(None)?;
            let batch = body.read()?;
            let operations = batch
                .get("operations")
                .and_then(serde_json::Value::as_array)
                .filter(|_| batch.is_object())
                .ok_or_else(|| {
                    CliError::Invalid(
                        "a batch is a JSON object holding `operations`, a list of put, patch and delete operations"
                            .into(),
                    )
                })?;
            output::queued_one(&core.write_rows(&item, &table, operations)?, json)
        }
        DeviceCommand::Rows {
            command: DeviceRowsCommand::Undo { item, table, batch },
        } => {
            let core = store.open(None)?;
            output::queued_one(&core.undo_rows(&item, &table, &batch)?, json)
        }
        DeviceCommand::Rows { command } => {
            let core = store.open_with_server(named)?;
            let answer = match command {
                DeviceRowsCommand::List(args) => core.table_rows(
                    &args.item,
                    &args.table,
                    &marfa_core::RowsAsked {
                        limit: args.page.limit.map(i64::from),
                        cursor: args.page.cursor.clone(),
                        filter: args.filter.clone(),
                        sort: args.sort.clone(),
                        direction: args.direction.map(|direction| direction.as_str().to_string()),
                    },
                )?,
                DeviceRowsCommand::Get { item, table, row } => core.table_row(&item, &table, &row)?,
                DeviceRowsCommand::Totals {
                    item,
                    table,
                    filter,
                } => core.table_totals(&item, &table, filter.as_deref())?,
                DeviceRowsCommand::Write { .. } | DeviceRowsCommand::Undo { .. } => {
                    return Err(CliError::Invalid("a row write is not a read".into()));
                }
            };
            output::report(&answer, json, || {
                serde_json::to_string_pretty(&answer).unwrap_or_default()
            })
        }
        DeviceCommand::Views { command } => {
            let core = store.open(None)?;
            match command {
                DeviceViewsCommand::List => {
                    let rows = core.list_views()?;
                    if !json {
                        output::note_partial(rows.completeness);
                    }
                    output::report(
                        &serde_json::json!({"completeness": rows.completeness, "views": rows.rows}),
                        json,
                        || rows.rows.iter().map(view_line).collect::<Vec<_>>().join("\n"),
                    )
                }
                DeviceViewsCommand::Get { id } => {
                    let row = core.view(&id)?.ok_or(CliError::not_held(&id))?;
                    output::report(&row, json, || view_line(&row))
                }
                DeviceViewsCommand::Groups { id, time_zone } => {
                    let rows = core.view_groups(&id, time_zone.as_deref())?;
                    output::report(
                        &serde_json::json!({"completeness": rows.completeness, "groups": rows.rows}),
                        json,
                        || rows.rows.iter().map(|group| {
                            format!("{}: {} item(s)", group.key, group.count)
                        }).collect::<Vec<_>>().join("\n"),
                    )
                }
            }
        }
        DeviceCommand::Folders { command } => {
            let row = match command {
                DeviceFoldersCommand::Get { id } => match store.open(None)?.folder(&id)? {
                    Some(row) => row,
                    None => return Err(CliError::not_held(&id)),
                },
                DeviceFoldersCommand::Create(args) => store.open_with_server(named)?.create_folder(
                    &args.settings.read()?,
                    args.idempotency.idempotency_key.as_deref(),
                )?,
                DeviceFoldersCommand::Change(args) => store.open_with_server(named)?.change_folder(
                    &args.id,
                    &args.settings.read()?,
                    args.version,
                    args.idempotency.idempotency_key.as_deref(),
                )?,
                DeviceFoldersCommand::Revoke { id, idempotency } => store
                    .open_with_server(named)?
                    .revoke_folder(&id, idempotency.idempotency_key.as_deref())?,
            };
            folder_row(&row, json)
        }
        DeviceCommand::Edges { command } => {
            let core = store.open(None)?;
            match command {
                EdgesCommand::Get { id } => match core.get_edge(&id)? {
                    Some(edge) => edge_one(&edge, json),
                    None => Err(CliError::not_held(&id)),
                },
                EdgesCommand::BulkGet { ids } => edge_list(&core.get_edges(&ids)?, json),
                EdgesCommand::List { item } => edge_list(&core.edges_from(&item)?, json),
                EdgesCommand::To { item } => edge_list(&core.edges_to(&item)?, json),
                EdgesCommand::Create {
                    source,
                    target,
                    type_,
                    properties: props,
                    id,
                } => {
                    let draft = EdgeDraft {
                        source_id: source,
                        target_id: target,
                        edge_type: type_,
                        properties: item_properties(&props)?,
                        id,
                    };
                    output::queued_one(&core.create_edge(&draft)?, json)
                }
                EdgesCommand::Check {
                    source,
                    target,
                    type_,
                    properties: props,
                    id,
                } => {
                    let draft = EdgeDraft {
                        source_id: source,
                        target_id: target,
                        edge_type: type_,
                        properties: item_properties(&props)?,
                        id,
                    };
                    core.check_edge(&draft)?;
                    output::report(&serde_json::json!({ "refused": false }), json, || {
                        "the copy finds nothing to refuse; the server judges the edge once it is sent"
                            .to_string()
                    })
                }
                EdgesCommand::CheckMove { id, source, target } => {
                    let (end, to) = match (source, target) {
                        (Some(source), None) => (marfa_core::End::Source, source),
                        (None, Some(target)) => (marfa_core::End::Target, target),
                        _ => unreachable!("clap requires exactly one end"),
                    };
                    core.check_edge_move(&id, end, &to)?;
                    output::report(&serde_json::json!({ "refused": false }), json, || {
                        "the copy finds nothing to refuse; the server judges the move once it is sent"
                            .to_string()
                    })
                }
                EdgesCommand::Update {
                    id,
                    properties: props,
                    version,
                    source,
                    target,
                } => {
                    let edit = EdgeEdit {
                        properties: item_properties(&props)?,
                        base_version: version,
                        source_id: source,
                        target_id: target,
                    };
                    match core.update_edge(&id, &edit)? {
                        Some(queued) => output::queued_one(&queued, json),
                        None => output::nothing_queued(json),
                    }
                }
                EdgesCommand::Delete { id } => output::queued_one(&core.delete_edge(&id)?, json),
            }
        }
        DeviceCommand::Tags { command } => {
            let core = store.open(None)?;
            let queued = match command {
                TagsCommand::Add { item, tag } => core.add_tag(&item, &tag)?,
                TagsCommand::Remove { item, tag } => core.remove_tag(&item, &tag)?,
            };
            output::queued_one(&queued, json)
        }
        DeviceCommand::Metadata { command } => {
            let core = store.open(None)?;
            let MetadataCommand::Replace { item, tags } = command;
            let write = MetadataWrite { tags };
            output::queued_one(&core.replace_metadata(&item, &write)?, json)
        }
        DeviceCommand::Extensions { command } => {
            let core = store.open(None)?;
            let queued = match command {
                ExtensionsCommand::Write {
                    item,
                    namespace,
                    body,
                } => {
                    properties(&body)?;
                    core.write_extension(&item, &namespace, &body)?
                }
                ExtensionsCommand::Delete { item, namespace } => {
                    core.delete_extension(&item, &namespace)?
                }
            };
            output::queued_one(&queued, json)
        }
        DeviceCommand::Queue => {
            let core = store.open(None)?;
            let queue = core.queue()?;
            output::queued(&queue, &queue, &core.pending_landings()?, json)
        }
        DeviceCommand::Forget { ids } => {
            let core = store.open(None)?;
            let cleared = if ids.is_empty() {
                core.forget_answered()?
            } else {
                core.forget_answered_ids(&ids)?
            };
            output::report(&cleared, json, || {
                format!("cleared {cleared} answered write(s)")
            })
        }
        DeviceCommand::Discard { id } => {
            let discarded = store.open(None)?.discard(&id)?;
            output::report(&discarded, json, || {
                if discarded {
                    format!("discarded {id} and what it carried")
                } else {
                    format!(
                        "nothing to discard: {id} is not a refused write, or a write still waits on it"
                    )
                }
            })
        }
        DeviceCommand::Drain => {
            stop_on_interrupt();
            let core = store.open_with_server(named)?;
            let report = core.drain_until(stop_after(None))?;
            output::drained(&report, json)?;
            return Ok(output::drain_exit(&report));
        }
        DeviceCommand::Release { id, reason } => {
            let core = store.open(None)?;
            let released = match (&id, &reason) {
                (_, Some(reason)) => core.release_reason(*reason)?,
                (Some(id), None) => usize::from(core.release(id)?),
                // clap refuses this; reached only if the argument rules drift.
                (None, None) => {
                    return Err(CliError::Invalid(
                        "name a queued write to release, or a reason to release every write blocked for it".into(),
                    ));
                }
            };
            output::report(&released, json, || {
                if released == 0 {
                    "nothing to release: a write is released only where it is blocked, dead or refused unsent, and never while it waits behind another write"
                        .into()
                } else if let Some(id) = &id {
                    format!("released {id}")
                } else {
                    format!("released {released} write(s)")
                }
            })
        }
        DeviceCommand::Withdraw { id } => {
            let withdrawn = store.open_with_server(named)?.withdraw(&id)?;
            output::report(&withdrawn, json, || {
                if withdrawn.is_empty() {
                    format!(
                        "nothing to withdraw: {id} is not dead or blocked ancestor_unavailable, conflict_unresolved, failing_alone, instance_changed or record_unread"
                    )
                } else {
                    format!(
                        "withdrew {}; the copy holds what the server holds",
                        withdrawn.join(", ")
                    )
                }
            })
        }
        DeviceCommand::Check => {
            let path = store.path()?;
            Core::check_store(path)?;
            output::report(
                &serde_json::json!({ "path": path, "whole": true }),
                json,
                || format!("{} reads whole", path.display()),
            )
        }
        DeviceCommand::SetAside => {
            let done = Core::set_aside_damaged(store.path()?)?;
            output::report(&done, json, || {
                let mut line = format!(
                    "set aside as {}; carried {} write(s) the server has not taken",
                    done.set_aside, done.carried
                );
                if done.unread > 0 {
                    line.push_str(&format!(
                        "\n{} write(s) could not be read{}",
                        done.unread,
                        if done.unread_ids.is_empty() {
                            String::new()
                        } else {
                            format!(": {}", done.unread_ids.join(", "))
                        }
                    ));
                }
                if !done.whole {
                    line.push_str("\nthe queue, or a record that decides how a carried write is sent, could not be read whole, so the store set aside may hold more");
                }
                if done.record_unread > 0 {
                    line.push_str(&format!(
                        "\n{} write(s) held blocked record_unread, since a record that decides how each is sent could not be read: release them to send them without it",
                        done.record_unread
                    ));
                }
                if done.held > 0 {
                    line.push_str(&format!(
                        "\n{} write(s) held blocked instance_changed, since the store did not say which instance it was built from: release them to send them",
                        done.held
                    ));
                }
                line.push_str("\nhydrate the new store, then drain, to send what it carries");
                line
            })
        }
        DeviceCommand::Status => {
            let status = store.open(None)?.status()?;
            output::report(&status, json, || {
                let listed = |names: &[String]| {
                    if names.is_empty() {
                        "(none)".to_string()
                    } else {
                        names.join(",")
                    }
                };
                format!(
                    "server {}\ninstance {}\nslice {} at {}\nedge types held whole {}\npinned {}\ncursor {}\nhydration {}\nsynced at {}\ncatalog version {}\n{} item(s), {} edge(s){}",
                    status.server_origin.as_deref().unwrap_or("(none)"),
                    status.instance_id.as_deref().unwrap_or("(none)"),
                    listed(&status.slice_types),
                    status
                        .slice_tier
                        .map(|tier| tier.to_string())
                        .unwrap_or_else(|| "(none)".into()),
                    listed(&status.slice_edge_types),
                    listed(&status.pinned),
                    status.event_cursor.as_deref().unwrap_or("(none)"),
                    status.hydration.as_str(),
                    status.synced_at.as_deref().unwrap_or("(never)"),
                    status
                        .catalog_version
                        .map_or_else(|| "(none)".into(), |version| version.to_string()),
                    status.items,
                    status.edges,
                    match (status.items_listed, status.items_expected) {
                        (Some(listed), Some(expected)) => {
                            format!("\nlisted {listed} of {expected}")
                        }
                        (Some(listed), None) => format!("\nlisted {listed}"),
                        _ => String::new(),
                    }
                ) + &format!("\n{}", file_cache_text(&status.file_cache))
            })
        }
        DeviceCommand::Types { command } => {
            let core = match command {
                TypesCommand::Served => {
                    stop_on_interrupt();
                    store.open_with_server(named)?
                }
                _ => store.open(None)?,
            };
            match command {
                TypesCommand::Served => {
                    let types = core.server_catalog_until(stop_after(None))?.item_types;
                    output::report(&types, json, || {
                        types.iter().map(type_line).collect::<Vec<_>>().join("\n")
                    })
                }
                TypesCommand::Declare { definitions, file } => {
                    let text = match (definitions, file) {
                        (Some(text), _) => text,
                        (None, Some(path)) => std::fs::read_to_string(&path).map_err(|error| {
                            CliError::Invalid(format!("cannot read {}: {error}", path.display()))
                        })?,
                        (None, None) => unreachable!("one of the two is required"),
                    };
                    marfa_core::refuse_inexact_integers(&text)?;
                    let parsed: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|error| CliError::Invalid(format!("not JSON: {error}")))?;
                    let definitions = match parsed {
                        serde_json::Value::Array(all) => all,
                        one @ serde_json::Value::Object(_) => vec![one],
                        _ => {
                            return Err(CliError::Invalid(
                                "a type definition is a JSON object, or an array of them".into(),
                            ));
                        }
                    };
                    core.declare_types(&definitions)?;
                    output::report(
                        &serde_json::json!({ "declared": definitions.len() }),
                        json,
                        || format!("declared {} type(s)", definitions.len()),
                    )
                }
                TypesCommand::Declared => {
                    let declared = core.declared_types()?;
                    output::report(&declared, json, || {
                        declared
                            .iter()
                            .filter_map(|held| held["id"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                }
                TypesCommand::List => {
                    let types = core.item_types()?;
                    output::report(&types, json, || {
                        types.iter().map(type_line).collect::<Vec<_>>().join("\n")
                    })
                }
                TypesCommand::Get { id } => {
                    let held = core.item_type(&id)?;
                    output::report(&held, json, || {
                        let mut lines = vec![type_line(&held)];
                        for (name, value) in [
                            ("title", &held.title_field),
                            ("body", &held.body_field),
                            ("icon", &held.icon),
                            ("link", &held.link_field),
                        ] {
                            if let Some(value) = value {
                                lines.push(format!("  {name} field {value}"));
                            }
                        }
                        if !held.name_from_body {
                            lines.push("  not named by its body".into());
                        }
                        lines.extend(held.fields.iter().map(field_line));
                        lines.extend(table_lines(&held.tables));
                        lines.join("\n")
                    })
                }
            }
        }
        DeviceCommand::EdgeTypes { command } => {
            let core = match command {
                CatalogCommand::Served => {
                    stop_on_interrupt();
                    store.open_with_server(named)?
                }
                _ => store.open(None)?,
            };
            match command {
                CatalogCommand::Served => {
                    let types = core.server_catalog_until(stop_after(None))?.edge_types;
                    output::report(&types, json, || {
                        types
                            .iter()
                            .map(edge_type_line)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                }
                CatalogCommand::List => {
                    let types = core.edge_types()?;
                    output::report(&types, json, || {
                        types
                            .iter()
                            .map(edge_type_line)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                }
                CatalogCommand::Get { id } => {
                    let held = core.edge_type(&id)?;
                    output::report(&held, json, || {
                        let mut lines = vec![
                            edge_type_line(&held),
                            format!(
                                "  from {} to {}, {} on delete",
                                held.source_type_constraints.join(","),
                                held.target_type_constraints.join(","),
                                held.cascade_on_delete
                            ),
                        ];
                        lines.extend(held.properties.iter().map(field_line));
                        lines.join("\n")
                    })
                }
            }
        }
    }
    .map(|()| Exit::Done)
}

/// Said only where a read of `read_only` moved items, which no event counted.
fn read_only_said(held: u64) -> String {
    if held == 0 {
        String::new()
    } else {
        format!("; {held} item(s) took a new read_only")
    }
}

fn view_line(row: &marfa_core::ViewRow) -> String {
    format!(
        "{} {} at version {}: {}",
        row.id,
        row.state.as_str(),
        row.version,
        row.settings
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("untitled")
    )
}

fn folder_row(row: &marfa_core::FolderRow, json: bool) -> Result<(), CliError> {
    output::report(row, json, || {
        format!(
            "{} {} at version {}: {}",
            row.id,
            row.state.as_str(),
            row.version,
            row.settings.title.as_deref().unwrap_or("untitled")
        )
    })
}

fn parse_file_budget(value: &str) -> Result<marfa_core::FileBudget, CliError> {
    match value {
        "keep-all" => Ok(marfa_core::FileBudget::KeepAll),
        "default" => Ok(marfa_core::FileBudget::Default),
        digits => digits
            .parse()
            .map(marfa_core::FileBudget::Bytes)
            .map_err(|_| {
                CliError::Invalid(format!(
                    "{digits:?} is not a byte count, `keep-all` or `default`"
                ))
            }),
    }
}

fn file_cache_text(cache: &marfa_core::FileCache) -> String {
    let setting = match cache.setting {
        marfa_core::FileBudget::Default => "default".to_string(),
        marfa_core::FileBudget::Bytes(bytes) => format!("{bytes} byte(s)"),
        marfa_core::FileBudget::KeepAll => "keep every file".to_string(),
    };
    let budget = cache
        .budget
        .map_or_else(|| "none".to_string(), |bytes| format!("{bytes} byte(s)"));
    let unreadable = if cache.volume_unreadable {
        " (the disk could not be read, so the default is 2 GiB)"
    } else {
        ""
    };
    let held = match (cache.held, &cache.held_unreadable) {
        (Some(held), _) => format!("{held} byte(s)"),
        (None, reason) => format!(
            "unknown, the cache could not be read: {}",
            reason.as_deref().unwrap_or("no reason given")
        ),
    };
    let mut text =
        format!("file budget {setting}, in force {budget}{unreadable}\nfiles held {held}");
    if let Some(failure) = &cache.backup_mark_failure {
        text.push_str(&format!(
            "\nfetched files could not be kept out of backups: {failure}"
        ));
    }
    text.push('\n');
    match &cache.attachments {
        Some(attachments) => text.push_str(&attachments_text(attachments)),
        None => text.push_str("attached files unknown"),
    }
    text
}

fn attachments_text(attachments: &marfa_core::Attachments) -> String {
    let mut text = format!(
        "attached files held {}, {} byte(s) outside the budget",
        attachments.held,
        attachments.held_bytes + attachments.partial_bytes
    );
    if attachments.not_held > 0 {
        text.push_str(&format!(
            "\nattached files not held {}, {} byte(s)",
            attachments.not_held, attachments.not_held_bytes
        ));
        for why in &attachments.not_held_by_reason {
            let reason = match why.reason {
                marfa_core::NotHeldReason::NotFetched => "not fetched yet",
                marfa_core::NotHeldReason::NoRoom => "no room on the disk",
                marfa_core::NotHeldReason::Unreachable => "the server could not be reached",
                marfa_core::NotHeldReason::RateLimited => "the server asked for a longer wait",
                marfa_core::NotHeldReason::Absent => "the server holds none",
                marfa_core::NotHeldReason::Failed => "the fetch failed",
                marfa_core::NotHeldReason::NotInCopy => "the file is outside the slice",
            };
            text.push_str(&format!(
                "\n  {}: {}, {} byte(s){}",
                reason,
                why.attachments,
                why.bytes,
                if why.unstated > 0 {
                    format!(", {} stating no size", why.unstated)
                } else {
                    String::new()
                }
            ));
        }
    }
    text
}

/// A repeatable flag given no value leaves the filter unset.
fn given<T>(values: Vec<T>) -> Option<Vec<T>> {
    (!values.is_empty()).then_some(values)
}

fn type_line(held: &marfa_core::ItemType) -> String {
    format!(
        "{}  {}{}  {} field(s)",
        held.id,
        held.label.as_deref().unwrap_or("(no label)"),
        held.parent
            .as_deref()
            .map_or(String::new(), |parent| format!("  inherits {parent}")),
        held.fields.len()
    ) + &match held.tables.len() {
        0 => String::new(),
        count => format!("  {count} table(s)"),
    }
}

fn table_lines(tables: &serde_json::Map<String, serde_json::Value>) -> Vec<String> {
    let mut lines = Vec::new();
    for (name, table) in tables {
        lines.push(format!("  table {name}"));
        for (column, definition) in table
            .get("columns")
            .and_then(serde_json::Value::as_object)
            .into_iter()
            .flatten()
        {
            let held = |key: &str| definition.get(key).and_then(serde_json::Value::as_str);
            lines.push(format!(
                "    {column}  {}{}{}",
                held("type").unwrap_or("unknown"),
                if definition.get("required") == Some(&serde_json::Value::Bool(true)) {
                    "  required"
                } else {
                    ""
                },
                held("adds_up").map_or(String::new(), |way| format!("  adds up as {way}")),
            ));
        }
    }
    lines
}

fn field_line(field: &marfa_core::TypeField) -> String {
    let words: Vec<String> = field
        .definition
        .get("status_values")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some(format!(
                "{}={}",
                entry.get("value")?.as_str()?,
                entry.get("group")?.as_str()?
            ))
        })
        .collect();
    format!(
        "  {}  {}{}  from {}{}",
        field.name,
        field.r#type,
        if field.required { "  required" } else { "" },
        field.declared_by,
        if words.is_empty() {
            String::new()
        } else {
            format!("  words {}", words.join(", "))
        }
    )
}

fn edge_type_line(held: &marfa_core::EdgeType) -> String {
    format!(
        "{}  {} / {}  {}{}  written at {}{}",
        held.id,
        held.label,
        held.reverse_label,
        held.cardinality,
        held.reverse_name
            .as_deref()
            .map_or(String::new(), |name| format!("  reverse {name}")),
        match held.written_at {
            marfa_core::WrittenAt::Source => "its source",
            marfa_core::WrittenAt::Target => "its target",
            marfa_core::WrittenAt::None => "no end",
        },
        if held.shipped { "  shipped" } else { "" }
    )
}

fn edge_list(edges: &[marfa_core::Edge], json: bool) -> Result<(), CliError> {
    output::report(&edges, json, || {
        edges.iter().map(edge_line).collect::<Vec<_>>().join("\n")
    })
}

fn changed_lines(changes: &marfa_core::CopyChanges) -> String {
    let mut lines = vec![format!("cursor {}", changes.cursor)];
    if changes.everything {
        lines.push("everything: read the whole copy again".into());
    }
    for (label, ids) in [
        ("item", &changes.items),
        ("removed item", &changes.removed_items),
        ("edge", &changes.edges),
        ("removed edge", &changes.removed_edges),
    ] {
        lines.extend(ids.iter().map(|id| format!("{label}  {id}")));
    }
    lines.join("\n")
}

fn edge_one(edge: &marfa_core::Edge, json: bool) -> Result<(), CliError> {
    output::report(edge, json, || edge_line(edge))
}

fn edge_line(edge: &marfa_core::Edge) -> String {
    format!(
        "{}  {} -> {}  {}  v{}",
        edge.id, edge.source_id, edge.target_id, edge.edge_type, edge.version
    )
}

fn blocked_reason() -> impl clap::builder::TypedValueParser<Value = marfa_core::BlockedReason> {
    use clap::builder::TypedValueParser;
    clap::builder::PossibleValuesParser::new(
        marfa_core::BlockedReason::ALL.map(marfa_core::BlockedReason::as_str),
    )
    .try_map(|reason| reason.parse::<marfa_core::BlockedReason>())
}

/// One line for a change: its event, the item or edge it was about, the
/// cursor it left, and why or what, where it has more to say.
fn change_line(change: &marfa_core::Change) -> String {
    format!(
        "{} {} (cursor {}){}",
        change.event,
        change
            .item_id
            .as_deref()
            .or(change.edge_id.as_deref())
            .unwrap_or("-"),
        change.cursor,
        match &change.event {
            marfa_core::ChangeEvent::ServerUnreachable(reason) => format!(": {reason}"),
            marfa_core::ChangeEvent::QueueNotDrained(error)
            | marfa_core::ChangeEvent::WatchFailed(error) => format!(": {error}"),
            marfa_core::ChangeEvent::QueueDrained(report) => format!(
                ": {}{}{}",
                crate::output::answered_and_held(report),
                if report.undelivered > 0 {
                    format!("; {} not delivered", report.undelivered)
                } else {
                    String::new()
                },
                report
                    .stopped
                    .as_deref()
                    .or(report.unavailable.as_deref())
                    .map(|why| format!("; {why}"))
                    .unwrap_or_default()
            ),
            marfa_core::ChangeEvent::Saved(version) => format!(": data version {version}"),
            _ => String::new(),
        }
    )
}

/// Prints each change a watch tells. A line that cannot be written, or a watch
/// that fails, raises `stop` and leaves its error for the command to end with.
struct Printing {
    json: bool,
    /// Prints a save as `saved (data version N)`, as `changes` always has.
    saves: bool,
    stop: &'static AtomicBool,
    problem: Mutex<Option<CliError>>,
    ended: std::sync::mpsc::Sender<()>,
}

impl Printing {
    fn fail(&self, error: CliError) {
        self.problem
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_or_insert(error);
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl marfa_core::WatchListener for Printing {
    fn changed(&self, change: &marfa_core::Change) {
        let written = match &change.event {
            marfa_core::ChangeEvent::WatchFailed(error) => {
                let written = output::line_of(change, self.json, || change_line(change));
                self.fail(error.clone().into());
                written
            }
            marfa_core::ChangeEvent::Saved(version) if self.saves => output::line_of(
                &serde_json::json!({ "data_version": version }),
                self.json,
                || format!("saved (data version {version})"),
            ),
            _ => output::line_of(change, self.json, || change_line(change)),
        };
        if let Err(error) = written {
            self.fail(error);
        }
    }

    fn ended(&self, error: Option<marfa_core::CoreError>) {
        if let Some(error) = error {
            self.fail(error.into());
        }
        let _ = self.ended.send(());
    }
}

/// Watches the store until `stop` is raised, printing each change. `joined`
/// runs once the watch is joined.
fn watching(
    core: &Arc<Core>,
    stop: &'static AtomicBool,
    json: bool,
    saves: bool,
    joined: impl FnOnce() -> Result<(), CliError>,
) -> Result<(), CliError> {
    let (ended, done) = std::sync::mpsc::channel();
    let printing = Arc::new(Printing {
        json,
        saves,
        stop,
        problem: Mutex::new(None),
        ended,
    });
    let listening = core.watch(false, printing.clone())?;
    joined()?;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(STOP_POLL);
    }
    // So that nothing is told after the command's last word.
    drop(listening);
    let _ = done.recv_timeout(std::time::Duration::from_secs(5));
    match printing
        .problem
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

const STOP_POLL: std::time::Duration = std::time::Duration::from_millis(100);

struct Store {
    db: Option<PathBuf>,
    reader: bool,
    makes: bool,
}

impl Store {
    fn path(&self) -> Result<&std::path::Path, CliError> {
        self.db.as_deref().ok_or(CliError::NoStoreNamed)
    }

    fn open(&self, session: Option<Session>) -> Result<Core, CliError> {
        let Some(path) = &self.db else {
            return Err(CliError::NoStoreNamed);
        };
        if (self.reader || !self.makes) && !path.exists() {
            return Err(CliError::NoStoreAt(path.clone()));
        }
        if self.reader {
            return Ok(Core::open_reader(path)?);
        }
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
            && !parent.exists()
        {
            std::fs::create_dir_all(parent)?;
        }
        let (server, renew) = Session::split(session);
        let core = Core::open(path, server)?;
        renewing(&core, renew);
        Ok(core)
    }

    /// A reader resolves no server: the core refuses server commands on a
    /// reading handle, so it needs no credential.
    fn open_with_server(&self, named: &Named) -> Result<Core, CliError> {
        if self.reader {
            return self.open(None);
        }
        self.open(Some(named.session()?))
    }
}

fn fill_line(fill: &marfa_core::FillReport) -> String {
    let failed = match &fill.failure {
        Some(reason) => format!("; {} table read(s) failed, last: {reason}", fill.failed),
        None => String::new(),
    };
    format!(
        "{} table(s) whole, {} read from the server, {} still to fill; {} page(s), {} row(s){failed}",
        fill.whole, fill.online, fill.unfilled, fill.pages, fill.rows
    )
}
