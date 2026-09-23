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

/// A page of items decodes as the envelope every list answers.
@Test func aPageDecodesAsTheEnvelope() throws {
    let json = Data(#"{"data":[],"next_cursor":null}"#.utf8)
    let page = try JSONDecoder().decode(Components.Schemas.EdgePage.self, from: json)
    #expect(page.data.isEmpty)
    #expect(page.nextCursor == nil)
}
