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

/// A page of items decodes as the envelope every list answers.
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
