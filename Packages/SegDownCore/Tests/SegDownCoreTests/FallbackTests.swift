// Guards the key-feature rule for when a failed page attempt falls back to the captured media.
import Foundation
import Testing
@testable import SegDownCore

struct FallbackTests {
    @Test func unsupportedSiteAndMissingYtDlpAlwaysFallBack() {
        for autoFallback in [true, false] {
            #expect(FallbackDecision.shouldFallback(error: JobError.unsupportedSite, autoFallback: autoFallback))
            #expect(FallbackDecision.shouldFallback(
                error: JobError.missingDependency(Tool.ytDlp.rawValue), autoFallback: autoFallback
            ))
        }
    }

    @Test func processFailureFallsBackOnlyWithAutoFallback() {
        let error = JobError.processFailed("yt-dlp failed (exit 1)")
        #expect(FallbackDecision.shouldFallback(error: error, autoFallback: true))
        #expect(!FallbackDecision.shouldFallback(error: error, autoFallback: false))
    }

    @Test func cancellationNeverFallsBack() {
        for autoFallback in [true, false] {
            #expect(!FallbackDecision.shouldFallback(error: CancellationError(), autoFallback: autoFallback))
            #expect(!FallbackDecision.shouldFallback(error: JobError.sizeExceeded(1), autoFallback: autoFallback))
        }
    }
}
