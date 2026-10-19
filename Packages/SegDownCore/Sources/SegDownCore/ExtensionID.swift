// The Chromium extension ID, shared by the app (host manifest installer) and segdown-host (origin check).
// Derived from the `key` in extension/manifest.json: first 32 hex chars of sha256(base64-decoded key),
// each hex digit 0-f mapped to a-p. Regenerate the key and this constant together.
public enum ExtensionID {
    public static let chrome = "kigkemeomlcgfgnknafeomgglcjeoicb"

    /// The `allowed_origins` entry and the origin Chrome passes to the host as `argv[1]`.
    public static var chromeOrigin: String { "chrome-extension://\(chrome)/" }
}
