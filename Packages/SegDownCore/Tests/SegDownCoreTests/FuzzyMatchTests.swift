// Guards the Downloads search: accent-less, scattered queries find a title, others don't, and
// ranking puts the closest match first without reordering ties.
import Testing
@testable import SegDownCore

struct FuzzyMatchTests {
    @Test func caseAndDiacriticDifferentQueriesMatch() {
        #expect(FuzzyMatch.score("tieng viet", in: "Tiếng Việt") != nil)
        #expect(FuzzyMatch.score("tv", in: "Tiếng Việt") != nil)
    }

    @Test func nonSubsequenceDoesNotMatch() {
        #expect(FuzzyMatch.score("xyz", in: "Tiếng Việt") == nil)
    }

    @Test func rankPutsContiguousFirstAndKeepsTieOrder() {
        // "a long prefix abc": the word later in the title counts, not the first "a".
        let titles = ["axbxc", "abc first", "nope", "a long prefix abc", "abc second"]
        let ranked = FuzzyMatch.rank(titles, query: "abc") { $0 }
        #expect(ranked == ["abc first", "a long prefix abc", "abc second", "axbxc"])
    }
}
