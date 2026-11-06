import MarkdownUI
import SwiftUI

/// Assistant output rendered as Markdown with fenced code blocks.
///
/// MarkdownUI parses per rendered value and paints with SwiftUI primitives; the
/// enclosing `LazyVStack` only builds visible rows, so a long transcript does not
/// pay for paragraphs that are off screen.
struct LocalMarkdown: View {
    let text: String

    var body: some View {
        Markdown(text)
            .markdownTheme(.gitHub)
            .textSelection(.enabled)
    }
}
