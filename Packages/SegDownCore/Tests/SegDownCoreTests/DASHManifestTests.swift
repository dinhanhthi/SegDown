// Guards the DASH core (segment URLs and durations from the MPDs ffmpeg writes) and the MPD
// input security boundary (DOCTYPE/ENTITY, non-http(s) URLs).
import Foundation
import Testing
@testable import SegDownCore

struct DASHManifestTests {
    private static let baseURL = URL(string: "https://cdn.example.com/d/out.mpd")!

    /// What `ffmpeg -f dash -seg_duration 4 -adaptation_sets "id=0,streams=v id=1,streams=a"`
    /// (ffmpeg 9.0.2) writes for a 12 s clip.
    private static let segmented = """
    <?xml version="1.0" encoding="utf-8"?>
    <MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    \txmlns="urn:mpeg:dash:schema:mpd:2011"
    \txmlns:xlink="http://www.w3.org/1999/xlink"
    \txsi:schemaLocation="urn:mpeg:DASH:schema:MPD:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd"
    \tprofiles="urn:mpeg:dash:profile:isoff-live:2011"
    \ttype="static"
    \tmediaPresentationDuration="PT12.0S"
    \tmaxSegmentDuration="PT4.0S"
    \tminBufferTime="PT8.0S">
    \t<ProgramInformation>
    \t</ProgramInformation>
    \t<ServiceDescription id="0">
    \t</ServiceDescription>
    \t<Period id="0" start="PT0.0S">
    \t\t<AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" frameRate="25/1" maxWidth="320" maxHeight="180" par="16:9">
    \t\t\t<Representation id="0" mimeType="video/mp4" codecs="avc1.f4000c" bandwidth="39824" width="320" height="180" sar="1:1">
    \t\t\t\t<SegmentTemplate timescale="12800" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
    \t\t\t\t\t<SegmentTimeline>
    \t\t\t\t\t\t<S t="0" d="51200" r="2" />
    \t\t\t\t\t</SegmentTimeline>
    \t\t\t\t</SegmentTemplate>
    \t\t\t</Representation>
    \t\t</AdaptationSet>
    \t\t<AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true">
    \t\t\t<Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="69000" audioSamplingRate="44100">
    \t\t\t\t<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="1" />
    \t\t\t\t<SegmentTemplate timescale="44100" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
    \t\t\t\t\t<SegmentTimeline>
    \t\t\t\t\t\t<S t="0" d="173056" />
    \t\t\t\t\t\t<S d="177152" r="1" />
    \t\t\t\t\t\t<S d="1840" />
    \t\t\t\t\t</SegmentTimeline>
    \t\t\t\t</SegmentTemplate>
    \t\t\t</Representation>
    \t\t</AdaptationSet>
    \t</Period>
    </MPD>
    """

    @Test func segmentTimelineGivesSegmentURLsAndDurations() throws {
        let manifest = try DASHManifest.parse(Self.segmented, baseURL: Self.baseURL)
        let duration = try #require(manifest.duration)
        #expect(duration == 12)

        let audio = try #require(manifest.audio)
        #expect(manifest.video.codecs == "avc1.f4000c")
        #expect(audio.codecs == "mp4a.40.2")
        #expect(manifest.video.ext == "mp4" && audio.ext == "mp4")

        for (track, id, count) in [(manifest.video, "0", 3), (audio, "1", 4)] {
            guard case let .segments(initURL, segments) = track.content else {
                Issue.record("Expected segments for stream \(id)")
                continue
            }
            #expect(initURL?.absoluteString == "https://cdn.example.com/d/init-stream\(id).m4s")
            #expect(segments.count == count)
            #expect(segments.first?.url.absoluteString == "https://cdn.example.com/d/chunk-stream\(id)-00001.m4s")
            #expect(segments.last?.url.absoluteString == "https://cdn.example.com/d/chunk-stream\(id)-0000\(count).m4s")
            let total = segments.reduce(0) { $0 + $1.duration }
            #expect(abs(total - duration) <= 0.1)
        }
    }

    /// What `ffmpeg -f dash -seg_duration 4 -single_file 1 …` (ffmpeg 9.0.2) writes: one file per
    /// stream, addressed by byte ranges, read whole.
    @Test func singleFileGivesResolvedBaseURLs() throws {
        let mpd = """
        <?xml version="1.0" encoding="utf-8"?>
        <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011"
        \ttype="static" mediaPresentationDuration="PT12.0S" maxSegmentDuration="PT4.0S" minBufferTime="PT8.0S">
        \t<Period id="0" start="PT0.0S">
        \t\t<AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" frameRate="25/1" maxWidth="320" maxHeight="180" par="16:9">
        \t\t\t<Representation id="0" mimeType="video/mp4" codecs="avc1.f4000c" bandwidth="39776" width="320" height="180" sar="1:1">
        \t\t\t\t<BaseURL>out-stream0.mp4</BaseURL>
        \t\t\t\t<SegmentList timescale="1000000" duration="4000000" startNumber="1">
        \t\t\t\t\t<Initialization range="0-813" />
        \t\t\t\t\t<SegmentURL mediaRange="814-20664" indexRange="814-865" />
        \t\t\t\t\t<SegmentURL mediaRange="20665-40064" indexRange="20665-20716" />
        \t\t\t\t\t<SegmentURL mediaRange="40065-59663" indexRange="40065-40116" />
        \t\t\t\t</SegmentList>
        \t\t\t</Representation>
        \t\t</AdaptationSet>
        \t\t<AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true">
        \t\t\t<Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="69000" audioSamplingRate="44100">
        \t\t\t\t<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="1" />
        \t\t\t\t<BaseURL>out-stream1.mp4</BaseURL>
        \t\t\t\t<SegmentList timescale="1000000" duration="4000000" startNumber="1">
        \t\t\t\t\t<Initialization range="0-763" />
        \t\t\t\t\t<SegmentURL mediaRange="764-35845" indexRange="764-815" />
        \t\t\t\t\t<SegmentURL mediaRange="35846-71400" indexRange="35846-35897" />
        \t\t\t\t\t<SegmentURL mediaRange="71401-106966" indexRange="71401-71452" />
        \t\t\t\t\t<SegmentURL mediaRange="106967-107514" indexRange="106967-107018" />
        \t\t\t\t</SegmentList>
        \t\t\t</Representation>
        \t\t</AdaptationSet>
        \t</Period>
        </MPD>
        """
        let manifest = try DASHManifest.parse(mpd, baseURL: Self.baseURL)

        #expect(manifest.video.content == .file(URL(string: "https://cdn.example.com/d/out-stream0.mp4")!))
        #expect(manifest.audio?.content == .file(URL(string: "https://cdn.example.com/d/out-stream1.mp4")!))
        #expect(manifest.video.bandwidth == 39776)
    }

    /// Untrusted XML: each row changes one thing in the segmented fixture.
    @Test func rejectsLiveDRMEntitiesAndNonHTTPURLs() {
        // The video template with `attributes` and no SegmentTimeline (12 s at timescale 12800).
        let durationTemplate = { (attributes: String) in
            Self.segmented
                .replacingOccurrences(
                    of: "\t\t\t\t\t<SegmentTimeline>\n\t\t\t\t\t\t<S t=\"0\" d=\"51200\" r=\"2\" />\n\t\t\t\t\t</SegmentTimeline>\n",
                    with: ""
                )
                .replacingOccurrences(of: "timescale=\"12800\"", with: "timescale=\"12800\" \(attributes)")
        }
        let rows: [(name: String, mpd: String, error: JobError)] = [
            (
                "dynamic",
                Self.segmented.replacingOccurrences(of: "type=\"static\"", with: "type=\"dynamic\""),
                .invalid("Live DASH streams aren't supported")
            ),
            (
                "ContentProtection",
                Self.segmented.replacingOccurrences(
                    of: "par=\"16:9\">",
                    with: "par=\"16:9\"><ContentProtection schemeIdUri=\"urn:mpeg:dash:mp4protection:2011\" value=\"cenc\"/>"
                ),
                .invalid("This video is DRM-protected, SegDown can't download it")
            ),
            (
                "DOCTYPE and ENTITY",
                Self.segmented.replacingOccurrences(
                    of: "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
                    with: "<?xml version=\"1.0\" encoding=\"utf-8\"?><!DOCTYPE MPD [<!ENTITY x SYSTEM \"file:///etc/passwd\">]>"
                ),
                .invalid("The DASH manifest has a DOCTYPE or ENTITY, SegDown doesn't read it")
            ),
            (
                "file media",
                Self.segmented.replacingOccurrences(
                    of: "media=\"chunk-stream$RepresentationID$-$Number%05d$.m4s\" startNumber=\"1\">\n\t\t\t\t\t<SegmentTimeline>\n\t\t\t\t\t\t<S t=\"0\" d=\"51200\"",
                    with: "media=\"file:///etc/$Number$\" startNumber=\"1\">\n\t\t\t\t\t<SegmentTimeline>\n\t\t\t\t\t\t<S t=\"0\" d=\"51200\""
                ),
                .invalid("The DASH manifest links to files that are not http(s)")
            ),
            (
                "huge S@r",
                Self.segmented.replacingOccurrences(of: "d=\"51200\" r=\"2\"", with: "d=\"51200\" r=\"100000\""),
                .invalid("The DASH manifest has too many segments")
            ),
            (
                "@duration over the segment cap",
                durationTemplate("duration=\"1\""),
                .invalid("The DASH manifest has too many segments")
            ),
            (
                "huge presentationTimeOffset with @duration",
                durationTemplate("duration=\"51200\" presentationTimeOffset=\"\(Int.max)\""),
                .invalid("The DASH manifest has an invalid segment duration")
            ),
        ]
        for row in rows {
            #expect(row.mpd != Self.segmented, "\(row.name): the fixture edit did not apply")
            #expect(throws: row.error, "\(row.name)") {
                try DASHManifest.parse(row.mpd, baseURL: Self.baseURL)
            }
        }
    }
}
