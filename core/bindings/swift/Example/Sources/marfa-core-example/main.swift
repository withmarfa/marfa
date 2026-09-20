import Foundation
import MarfaCore

let environment = ProcessInfo.processInfo.environment
guard let url = environment["MARFA_API_URL"], let key = environment["MARFA_API_KEY"] else {
    FileHandle.standardError.write(Data("set MARFA_API_URL and MARFA_API_KEY\n".utf8))
    exit(2)
}
let path = environment["MARFA_DB"]
    ?? FileManager.default.temporaryDirectory.appendingPathComponent("marfa-core-example.sqlite").path
let query = CommandLine.arguments.dropFirst().first ?? "lighthouse"

func title(of item: Item) throws -> String {
    let properties = try JSONSerialization.jsonObject(with: Data(item.propertiesJson.utf8)) as? [String: Any]
    return (properties?["title"] as? String) ?? (properties?["body"] as? String) ?? "(untitled)"
}

do {
    let core = try MarfaCore.open(path: path, url: url, key: key)
    let hydrated = try core.hydrate(types: ["core.note", "core.file"], tier: .library)
    print("hydrated \(hydrated.items) item(s) in \(hydrated.pages) page(s); cursor \(hydrated.cursor)")

    let notes = try core.list(
        filters: ListFilters(type: "core.note", limit: 5),
        sort: Sort(field: .createdAt, direction: .descending)
    )
    print("notes:")
    for note in notes {
        print("  \(note.id)  \(note.occurredAt)  \(try title(of: note))")
    }

    let hits = try core.search(query: query, filters: SearchFilters(), limit: 5)
    print("search \"\(query)\":")
    for hit in hits {
        print("  \(String(format: "%.3f", hit.score))  \(hit.item.type)  \(try title(of: hit.item))")
    }

    let caught = try core.catchUp()
    print("catch-up applied \(caught.applied), skipped \(caught.skipped); cursor \(caught.cursor)")

    let status = try core.status()
    print("status: \(status.items) item(s), slice \(status.sliceTypes.joined(separator: ",")), hydration \(status.hydration)")
} catch {
    FileHandle.standardError.write(Data("marfa-core-example: \(error)\n".utf8))
    exit(1)
}
