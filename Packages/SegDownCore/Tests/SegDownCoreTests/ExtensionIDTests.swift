// Guards the caller check of segdown-host: only SegDown's Chrome extension or Firefox add-on may start it.
import Testing
@testable import SegDownCore

struct ExtensionIDTests {
    @Test func acceptsOnlySegDownsExtension() {
        let exe = "/Applications/SegDown.app/Contents/MacOS/segdown-host"
        let manifest = "/path/manifest.json"
        #expect(ExtensionID.isAllowedCaller([exe, ExtensionID.chromeOrigin]))
        #expect(ExtensionID.isAllowedCaller([exe, manifest, ExtensionID.firefox]))
        #expect(!ExtensionID.isAllowedCaller([exe, manifest, "other@example.com"]))
        #expect(!ExtensionID.isAllowedCaller([exe]))
    }
}
