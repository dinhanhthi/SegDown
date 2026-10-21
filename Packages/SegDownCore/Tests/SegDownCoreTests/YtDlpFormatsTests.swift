// Guards the parsing of yt-dlp's `%(formats.:.{height,vcodec,protocol})j` line for the Quality picker.
import Testing
@testable import SegDownCore

struct YtDlpFormatsTests {
    @Test func parsesVideoHeightsTallestFirst() {
        let output = """
        WARNING: [youtube] Some formats may be missing
        [{"height": 27, "vcodec": "none", "protocol": "mhtml"}, {"vcodec": "none", "protocol": "https"}, \
        {"height": 360, "vcodec": "avc1.4d401e", "protocol": "https"}, {"height": 1080, "vcodec": "avc1.640028", "protocol": "https"}, \
        {"height": 720, "protocol": "m3u8_native"}, {"height": 1080, "vcodec": "vp09.00.40.08", "protocol": "https"}, \
        {"height": 144, "vcodec": "av01.0.00M.08", "protocol": "https"}]
        """
        #expect(YtDlpFormats.parseHeights(output) == [1080, 720, 360, 144])
    }

    @Test func parsesGarbageToNothing() {
        #expect(YtDlpFormats.parseHeights("NA").isEmpty)
        #expect(YtDlpFormats.parseHeights("[not json").isEmpty)
        #expect(YtDlpFormats.parseHeights("").isEmpty)
        #expect(YtDlpFormats.parseHeights(#"[1080, "720"]"#).isEmpty)
    }
}
