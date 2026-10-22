// The Chromium extension ID, shared by the app (host manifest installer) and segdown-host (origin check).
// Derived from the `key` in extension/manifest.json: first 32 hex chars of sha256(base64-decoded key),
// each hex digit 0-f mapped to a-p. Regenerate the key and this constant together.
public enum ExtensionID {
    public static let chrome = "kigkemeomlcgfgnknafeomgglcjeoicb"

    /// The `allowed_origins` entry and the origin Chrome passes to the host as `argv[1]`.
    public static var chromeOrigin: String { "chrome-extension://\(chrome)/" }

    /// The Firefox add-on's gecko id. Must equal the id scripts/build-firefox-addon.sh writes into the manifest.
    public static let firefox = "me@dinhanhthi.com"

    /// Whether segdown-host was started by SegDown's extension. Chrome passes its origin as `argv[1]`;
    /// Firefox passes the host manifest path as `argv[1]` and the add-on's gecko id as `argv[2]`.
    public static func isAllowedCaller(_ arguments: [String]) -> Bool {
        (arguments.count >= 2 && arguments[1] == chromeOrigin)
            || (arguments.count >= 3 && arguments[2] == firefox)
    }
}
