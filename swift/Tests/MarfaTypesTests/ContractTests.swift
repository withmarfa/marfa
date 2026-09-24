import Foundation
import MarfaTypes
import Testing

/// The root's answer decodes into the generated type, and the contract the
/// package was generated for is the document's.
@Test func theRootDecodesWithItsContract() throws {
    let json = Data(
        #"{"name":"marfa","version":"dev","instance_id":"00000000-0000-7000-8000-000000000000","contract":\#(marfaContractVersion),"features":["items"]}"#
            .utf8
    )
    let root = try JSONDecoder().decode(
        Operations.GetInstance.Output.Ok.Body.JsonPayload.self,
        from: json
    )
    #expect(root.contract == marfaContractVersion)
}

/// The document the package was generated from, where it sits in the
/// repository; a released package carries the sources, not the document.
private let document = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("openapi.json")

/// The constant is the document's `info.version`, read off the document
/// rather than off the constant itself.
@Test(.enabled(if: FileManager.default.fileExists(atPath: document.path)))
func theContractIsTheDocuments() throws {
    let info = try JSONDecoder().decode(
        Document.self,
        from: Data(contentsOf: document)
    ).info
    #expect(info.version == String(marfaContractVersion))
}

private struct Document: Decodable {
    struct Info: Decodable { let version: String }
    let info: Info
}

/// An empty page of edges decodes as the envelope every list answers.
@Test func aPageDecodesAsTheEnvelope() throws {
    let json = Data(#"{"data":[],"next_cursor":null}"#.utf8)
    let page = try JSONDecoder().decode(Components.Schemas.EdgePage.self, from: json)
    #expect(page.data.isEmpty)
    #expect(page.nextCursor == nil)
}

/// A page with rows and a cursor still to follow decodes too, the snake-case
/// names reaching their Swift spellings.
@Test func aPopulatedPageDecodesWithItsCursor() throws {
    let json = Data(
        #"{"data":[{"id":"e1","source_id":"a","target_id":"b","edge_type":"core.references","properties":{},"created_at":"2026-09-23T00:00:00Z","updated_at":"2026-09-23T00:00:00Z","version":1}],"next_cursor":"c1"}"#
            .utf8
    )
    let page = try JSONDecoder().decode(Components.Schemas.EdgePage.self, from: json)
    #expect(page.data.map(\.sourceId) == ["a"])
    #expect(page.data.first?.edgeType == "core.references")
    #expect(page.nextCursor == "c1")
}

/// A page of items reads each row as the one shape it is: a plain item, or
/// the item beside its metadata when `include` names `metadata`.
@Test func aPageOfItemsReadsEachRowAsItsShape() throws {
    let item = #"{"id":"i1","type":"core.note","state":"active","tier":"library","properties":{"title":"A note"},"created_at":"2026-09-24T00:00:00Z","updated_at":"2026-09-24T00:00:00Z","occurred_at":"2026-09-24T00:00:00Z","version":1,"source":"s","schema_version":1}"#
    let plain = try JSONDecoder().decode(
        Components.Schemas.ItemPage.self,
        from: Data(#"{"data":[\#(item)],"next_cursor":null}"#.utf8)
    )
    guard case let .Item(row)? = plain.data.first else {
        Issue.record("a plain row read as \(String(describing: plain.data.first))")
        return
    }
    #expect(row.id == "i1")
    let withMetadata = try JSONDecoder().decode(
        Components.Schemas.ItemPage.self,
        from: Data(
            #"{"data":[{"item":\#(item),"metadata":{"item_id":"i1","tags":["t"],"extensions":{}}}],"next_cursor":null}"#
                .utf8
        )
    )
    guard case let .ItemWithMetadata(row)? = withMetadata.data.first else {
        Issue.record("a row with its metadata read as \(String(describing: withMetadata.data.first))")
        return
    }
    #expect(row.metadata.tags == ["t"])
}
