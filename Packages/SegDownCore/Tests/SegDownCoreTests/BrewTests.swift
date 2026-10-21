// Guards the `brew outdated --json=v2` contract the Dependencies page's update check relies on.
import Foundation
import Testing
@testable import SegDownCore

struct BrewTests {
    @Test func parsesOutdatedFormulas() throws {
        let json = """
        {"formulae":[{"name":"deno","installed_versions":["2.6.8"],"current_version":"2.9.7","pinned":false,"pinned_version":null},\
        {"name":"yt-dlp","installed_versions":["2026.2.4"],"current_version":"2026.8.19_2","pinned":false,"pinned_version":null},\
        {"name":"ffmpeg","installed_versions":["8.1.1"],"current_version":"9.0.2_1","pinned":true,"pinned_version":"8.1.1"}],"casks":[]}
        """
        let outdated = try Brew.parseOutdated(json)
        #expect(outdated == [
            Brew.Outdated(name: "deno", installedVersions: ["2.6.8"], currentVersion: "2.9.7", pinned: false, pinnedVersion: nil),
            Brew.Outdated(name: "yt-dlp", installedVersions: ["2026.2.4"], currentVersion: "2026.8.19_2", pinned: false, pinnedVersion: nil),
            Brew.Outdated(name: "ffmpeg", installedVersions: ["8.1.1"], currentVersion: "9.0.2_1", pinned: true, pinnedVersion: "8.1.1"),
        ])
    }

    @Test func parsesNothingOutdated() throws {
        #expect(try Brew.parseOutdated(#"{"formulae":[],"casks":[]}"#).isEmpty)
    }

    @Test func skipsAutoUpdateReport() throws {
        let stdout = """
        ==> Auto-updated Homebrew!
        Updated 2 taps (homebrew/core and homebrew/cask).
        ==> New Formulae
        some-formula

        {
          "formulae": [
            {
              "name": "deno",
              "installed_versions": ["2.6.8"],
              "current_version": "2.9.7",
              "pinned": false,
              "pinned_version": null
            }
          ],
          "casks": []
        }
        """
        #expect(try Brew.parseOutdated(stdout) == [
            Brew.Outdated(name: "deno", installedVersions: ["2.6.8"], currentVersion: "2.9.7", pinned: false, pinnedVersion: nil),
        ])
    }
}
