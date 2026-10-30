// Guards the core of the main path: picking the variant and audio rendition from a master playlist.
import Foundation
import Testing
@testable import SegDownCore

struct HLSPlaylistTests {
    @Test func picksHighestBandwidthWithResolvedURIsAndAudio() throws {
        let master = """
        #EXTM3U
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
        360p/index.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"
        720p/index.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080,AUDIO="aud"
        file:///etc/passwd
        """
        let playlist = try HLSPlaylist.parse(master, baseURL: URL(string: "https://cdn.example.com/v/master.m3u8")!)
        let selection = try #require(playlist.pickVariant())

        #expect(selection.variant.url.absoluteString == "https://cdn.example.com/v/720p/index.m3u8")
        #expect(selection.audioURL?.absoluteString == "https://cdn.example.com/v/audio/en.m3u8")
        // Untrusted playlist text: the file: variant is dropped, even though it has the highest bandwidth.
        #expect(!playlist.variants.contains { $0.url.scheme == "file" })
    }

    /// A site-encrypted segment list (seen on streamc.xyz) fails with a clear error instead of
    /// ffmpeg's "End of file".
    @Test func rejectsSiteEncryptedPlaylist() {
        let encrypted = """
        #EXTM3U
        #ENC-AESGCM;iv=229143bbaaf91d615d825f67
        #EXT-X-B65:0-138
        XWYeNGPYBUS+RBCKoo19UvND5D+lnszy1unDr74XifRzX++d0wQq0f8JShVhAXH
        """
        #expect(throws: HLSPlaylist.encryptedError) {
            try HLSPlaylist.parse(encrypted, baseURL: URL(string: "https://embed.example.com/eyJ0/x")!)
        }
    }
}
