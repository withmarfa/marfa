import Foundation
import MarfaCore

// Phases, run in order by `scripts/binding-proof.sh`: `hydrate` pulls a
// slice, `write` queues writes while the server is stopped, `drain` sends
// them once it is back, `follow` is told of a note made on the server while
// the stream is held, and `thumbnail` reads what a second store holds of a
// type with a thumbnail.
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

// What the core tells of each change as it lands, from a thread of its own.
final class Collector: ChangeListener, @unchecked Sendable {
    private let lock = NSLock()
    private var held: [Change] = []
    var changes: [Change] { lock.withLock { held } }
    func changed(change: Change) { lock.withLock { held.append(change) } }
    func ended(error: MarfaError?) {
        if let error { FileHandle.standardError.write(Data("follow ended: \(error)\n".utf8)) }
    }
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
        let attachment = path + ".attachment.txt"
        try Data("bytes attached with the server away\n".utf8).write(to: URL(fileURLWithPath: attachment))
        let attached = try core.attach(id: firstId, path: attachment, attachment: Attachment())
        expect(attached.item.dependsOn.contains(attached.upload.id), "the attached file item does not wait on its upload")
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
        // The bytes, fetched into a store that has never held them, through
        // the link the server gives.
        let upload = report.verdicts.first { $0.kind == .uploadBlob }
        let hash = try core.queue().first { $0.id == upload?.id }?.blob
        expect(hash != nil, "no upload was drained")
        let fresh = try MarfaCore.open(path: path + ".fresh", url: url, key: key)
        let fetched = try fresh.blob(hash: hash ?? "")
        print("fetched \(hash ?? "-") into a fresh store")
        expect(
            (try? String(contentsOfFile: fetched, encoding: .utf8)) == "bytes attached with the server away\n",
            "the bytes fetched are not the bytes attached")
        print("cleared \(try core.forgetAnswered()) answered write(s); \(try core.queue().count) left")
        expect(try core.queue().isEmpty, "answered writes were left in the queue")

    case "follow":
        // Held open while the binary makes a note on the server; the change
        // arrives here, and a reader on the same store is told the copy saved.
        let reader = try MarfaCore.openReader(path: path)
        let before = try reader.dataVersion()
        let collector = Collector()
        let subscription = core.follow(listener: collector)
        func made() -> Change? {
            collector.changes.first { change in
                guard let id = change.itemId, let item = try? core.get(id: id) else { return false }
                return (try? title(of: item)) == "Made by the binary"
            }
        }
        let deadline = Date().addingTimeInterval(30)
        while made() == nil && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        subscription.stop()
        let change = made()
        print("followed: \(change.map { "\($0.event) \($0.itemId ?? "-") at \($0.cursor)" } ?? "nothing")")
        expect(change?.event == "item.created", "the note the binary made did not arrive through follow")
        expect(try reader.dataVersion() != before, "a reader on the same store was not told the copy saved")

    case "thumbnail":
        // A store of its own, holding the type the script registered: one
        // item carrying an image, and one holding a value under the field
        // from before the type declared it a thumbnail.
        let copy = try MarfaCore.open(path: path + ".thumbnail", url: url, key: key)
        _ = try copy.hydrate(types: ["user.snapshot"], tier: .library)
        let snapshots = try copy.list(
            filters: ListFilters(type: "user.snapshot"), sort: Sort(field: .createdAt, direction: .ascending))
        let image = try snapshots.first { try title(of: $0) == "With an image" }
        let early = try snapshots.first { try title(of: $0) == "Held before" }
        expect(image != nil && early != nil, "the snapshots were not hydrated")
        let read = try copy.thumbnail(id: image?.id ?? "")
        print("thumbnail: \(read?.mimeType ?? "none") of \(read?.bytes.count ?? 0) bytes")
        expect(
            read?.mimeType == "image/png" && read?.bytes.first == 0x89
                && read.map { Data($0.bytes.dropFirst(8)) } == Data("binding proof".utf8),
            "the thumbnail read is not the image the item carries")
        do {
            _ = try copy.thumbnail(id: "not-held")
            expect(false, "an item the copy does not hold was answered")
        } catch MarfaError.NotFound(let code, let message) {
            print("not held: \(code): \(message)")
            expect(code == "not_held", "an item the copy does not hold was not refused as not held")
        }
        do {
            _ = try copy.thumbnail(id: early?.id ?? "")
            expect(false, "a held value that is not an image was answered as one")
        } catch MarfaError.Decoding(let message) {
            print("held before: \(message)")
            expect(message.contains(early?.id ?? "-"), "the refusal of a held value that is not an image names no item")
        }

    default:
        FileHandle.standardError.write(Data("name a phase: hydrate, write, drain, follow or thumbnail\n".utf8))
        exit(2)
    }
} catch {
    FileHandle.standardError.write(Data("marfa-core-example: \(error)\n".utf8))
    exit(1)
}
if failed { exit(1) }
