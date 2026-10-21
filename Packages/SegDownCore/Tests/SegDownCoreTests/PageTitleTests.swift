// Guards the key-feature contract of the generic tab title check and the yt-dlp title cleanup.
import Foundation
import Testing
@testable import SegDownCore

struct PageTitleTests {
    private let reel = URL(string: "https://www.facebook.com/reel/2009437383034028")!

    @Test func siteNameTitlesAreGeneric() {
        #expect(PageTitle.isGeneric("Facebook", pageURL: reel))
        #expect(PageTitle.isGeneric("(3) Facebook", pageURL: reel))
        #expect(!PageTitle.isGeneric("Some real video title", pageURL: reel))
    }

    @Test func cleanDropsFacebookCountsAndURLs() {
        let raw = "120K views · 1.9K reactions | 📌 Phim Insidious 4 - Tiếng Còi Âm Dương Đánh Thức Ký Ức Ám Ảnh Tuổi Thơ Bị Phong Ấn https://s.shopee.vn/3LQhEf2M9E | Góc Nhìn Cinema"
        #expect(PageTitle.clean(raw) == "📌 Phim Insidious 4 - Tiếng Còi Âm Dương Đánh Thức Ký Ức Ám Ảnh Tuổi Thơ Bị Phong Ấn | Góc Nhìn Cinema")
        #expect(PageTitle.clean("https://example.com/x") == nil)
    }
}
