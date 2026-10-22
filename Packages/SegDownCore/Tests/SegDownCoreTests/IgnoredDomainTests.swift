// The ignored sites list only ever holds bare lowercase hostnames.
import Testing
@testable import SegDownCore

struct IgnoredDomainTests {
    @Test func pastedURLBecomesItsLowercaseHost() {
        #expect(IgnoredDomain.normalize("  https://WWW.YouTube.com:443/watch?v=1 ") == "www.youtube.com")
    }

    @Test func pathIsDropped() {
        #expect(IgnoredDomain.normalize("example.com/path") == "example.com")
    }

    @Test func rejectsWhatIsNotADomain() {
        #expect(IgnoredDomain.normalize("not a domain") == nil)
        #expect(IgnoredDomain.normalize("") == nil)
    }

    @Test func siteDropsWwwUnlessThatLeavesNoDot() {
        #expect(IgnoredDomain.site(forHost: "www.YouTube.com") == "youtube.com")
        #expect(IgnoredDomain.site(forHost: "www.com") == "www.com")
    }

    @Test func coversTheDomainAndItsSubdomainsOnly() {
        #expect(IgnoredDomain.covers("youtube.com", host: "m.youtube.com"))
        #expect(IgnoredDomain.covers("youtube.com", host: "youtube.com"))
        #expect(!IgnoredDomain.covers("youtube.com", host: "notyoutube.com"))
    }
}
