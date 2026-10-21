// Fuzzy title matching for the Downloads search: each query term is a case- and
// diacritic-insensitive subsequence of the title (titles are often Vietnamese, so "đ" folds to "d").
import Foundation

public enum FuzzyMatch {
    /// Score of `query` in `text`, higher is better; nil when a term is not a subsequence of the
    /// folded text. Terms are split on whitespace and their scores summed; an empty query gives 0.
    public static func score(_ query: String, in text: String) -> Int? {
        let chars = Array(fold(text))
        var total = 0
        for term in query.split(whereSeparator: \.isWhitespace) {
            guard let score = termScore(Array(fold(String(term))), in: chars) else { return nil }
            total += score
        }
        return total
    }

    /// The items whose `text` matches `query`, best score first; ties keep their input order.
    public static func rank<T>(_ items: [T], query: String, text: (T) -> String) -> [T] {
        items.enumerated()
            .compactMap { index, item in score(query, in: text(item)).map { (index, item, $0) } }
            .sorted { $0.2 != $1.2 ? $0.2 > $1.2 : $0.0 < $1.0 }
            .map(\.1)
    }

    /// Lowercased, without diacritics, with "đ"/"Đ" as "d".
    static func fold(_ text: String) -> String {
        text.replacingOccurrences(of: "đ", with: "d")
            .replacingOccurrences(of: "Đ", with: "d")
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    /// The best greedy left-to-right subsequence match over every place the term's first character
    /// occurs: 1 per matched character, +5 when it follows the previous match, +3 at a word start,
    /// -1 per character skipped between two matches.
    static func termScore(_ term: [Character], in chars: [Character]) -> Int? {
        guard let first = term.first else { return 0 }
        return chars.indices.filter { chars[$0] == first }
            .compactMap { termScore(term, in: chars, from: $0) }
            .max()
    }

    private static func termScore(_ term: [Character], in chars: [Character], from start: Int) -> Int? {
        var score = 0
        var next = start
        var previous: Int?
        for want in term {
            guard let index = chars[next...].firstIndex(of: want) else { return nil }
            score += 1 - (index - next)
            if let previous, previous == index - 1 { score += 5 }
            if index == 0 || !(chars[index - 1].isLetter || chars[index - 1].isNumber) { score += 3 }
            previous = index
            next = index + 1
        }
        return score
    }
}
