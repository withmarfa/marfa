import Foundation
import MarfaCore

// Three phases, run in order with the server stopped between the first and
// the last: `hydrate` pulls a slice, `write` queues writes while nothing can
// be sent, and `drain` sends them once the server is back.
let environment = ProcessInfo.processInfo.environment
guard let url = environment["MARFA_API_URL"], let key = environment["MARFA_API_KEY"],
    let path = environment["MARFA_DB"]
else {
    FileHandle.standardError.write(Data("set MARFA_API_URL, MARFA_API_KEY and MARFA_DB\n".utf8))
    exit(2)
}
let phase = CommandLine.arguments.dropFirst().first ?? ""

func describe(_ verdict: Verdict?) -> String {
    switch verdict {
    case nil: "unanswered"
    case .accepted: "accepted"
    case .merged(let fields): "merged \(fields)"
    case .conflicted(let sibling, let fields): "conflicted, sibling \(sibling) \(fields)"
    case .refused(let reason): "refused: \(reason)"
    case .blocked(let reason): "blocked: \(reason)"
    case .dead: "dead"
    }
}

func title(of item: Item) throws -> String {
    let properties = try JSONSerialization.jsonObject(with: Data(item.propertiesJson.utf8)) as? [String: Any]
    return (properties?["title"] as? String) ?? "(untitled)"
}

// Prints a failed expectation and fails the run, so the proof is a check
// rather than a transcript someone has to read.
nonisolated(unsafe) var failed = false
func expect(_ held: Bool, _ expectation: String) {
    guard !held else { return }
    FileHandle.standardError.write(Data("proof failed: \(expectation)\n".utf8))
    failed = true
}

func printQueue(_ core: MarfaCore) throws {
    for write in try core.queue() {
        print("  \(write.kind)  \(write.itemId ?? "-")  \(describe(write.verdict))  refusals \(write.refusals)")
    }
}

do {
    let core = try MarfaCore.open(path: path, url: url, key: key)
    switch phase {
    case "hydrate":
        let hydrated = try core.hydrate(types: ["core.note"], tier: .feed)
        print("hydrated \(hydrated.items) item(s) at feed; cursor \(hydrated.cursor); handle \(core.heldHandle())")

    case "write":
        let first = try core.createItem(
            draft: Draft(type: "core.note", propertiesJson: #"{"title":"Swift first","body":"written with the server away"}"#, tier: .feed))
        let second = try core.createItem(
            draft: Draft(type: "core.note", propertiesJson: #"{"title":"Swift second","body":"the other end of a link"}"#, tier: .feed))
        guard let firstId = first.itemId, let secondId = second.itemId,
            let held = try core.get(id: firstId)
        else { throw MarfaError.Invalid(message: "a queued create named no item") }
        _ = try core.updateItem(
            id: firstId, edit: Edit(propertiesJson: #"{"title":"Swift first, edited"}"#, baseVersion: held.version))
        _ = try core.addTag(id: firstId, tag: "favorite")
        _ = try core.createEdge(draft: EdgeDraft(sourceId: firstId, targetId: secondId, edgeType: "references"))
        let third = try core.createItem(
            draft: Draft(type: "core.note", propertiesJson: #"{"title":"Swift third","body":"deleted before it was sent"}"#, tier: .feed))
        _ = try core.deleteItem(id: third.itemId ?? "")
        _ = try core.createItem(draft: Draft(type: "system.device", propertiesJson: #"{"name":"not the device's to write"}"#))
        print("queued, nothing answered:")
        try printQueue(core)
        let offline = try core.drain()
        let answered = offline.verdicts.filter { $0.verdict != nil }.count
        print("drain with the server away: sent \(offline.sent), answered \(answered)")
        expect(answered == 0, "a drain with the server away answered a write")
        expect(
            try core.queue().allSatisfy { $0.refusals == 0 },
            "a drain with the server away counted a refusal against a write")
        let local = try core.search(
            query: "swift", filters: SearchFilters(type: "core.note", tags: ["favorite"]), limit: 10)
        let found = try local.map { try title(of: $0.item) }
        print("local search for favorites: \(found)")
        expect(found == ["Swift first, edited"], "a local search for the tagged edit did not find exactly it")

    case "drain":
        let report = try core.drain()
        print("drain: sent \(report.sent), held \(report.held)")
        for verdict in report.verdicts {
            print("  \(verdict.kind)  \(verdict.itemId ?? "-")  \(describe(verdict.verdict))")
        }
        let outcomes = report.verdicts.map { describe($0.verdict) }
        let refusal = "refused: type_not_permitted"
        expect(
            outcomes.filter { $0 == refusal }.count == 1, "the system.device create was not refused type_not_permitted")
        expect(
            outcomes.filter { $0 != refusal }.allSatisfy { $0 == "accepted" },
            "a write other than the system.device create was not accepted")
        let notes = try core.list(
            filters: ListFilters(type: "core.note", tier: .feed), sort: Sort(field: .createdAt, direction: .descending))
        print("notes now: \(try notes.map { "\(try title(of: $0)) v\($0.version) \($0.tags)" })")
        let edited = try notes.first { try title(of: $0) == "Swift first, edited" }
        expect(edited?.version == 2, "the edit was not answered at version 2")
        expect(edited?.tags.contains("favorite") == true, "the edit lost its tag")
        expect(try !notes.contains { try title(of: $0) == "Swift third" }, "the note deleted offline is still listed")
        print("cleared \(try core.forgetAnswered()) answered write(s); \(try core.queue().count) left")
        expect(try core.queue().isEmpty, "answered writes were left in the queue")

    default:
        FileHandle.standardError.write(Data("name a phase: hydrate, write or drain\n".utf8))
        exit(2)
    }
} catch {
    FileHandle.standardError.write(Data("marfa-core-example: \(error)\n".utf8))
    exit(1)
}
if failed { exit(1) }
