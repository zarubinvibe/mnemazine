import SwiftUI

struct MarkdownBlock: Equatable {
    enum Kind: Equatable { case paragraph, heading(Int), quote, code, item, divider }
    var kind: Kind
    var text: String

    // ponytail: the result format needs prose, lists, quotes and fenced code.
    // Tables remain selectable text until real reports require a table renderer.
    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = [], code: [String] = []
        var inCode = false
        func flush() {
            if !paragraph.isEmpty { blocks.append(.init(kind: .paragraph, text: paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        for line in text.components(separatedBy: .newlines) {
            if line.hasPrefix("```") {
                flush()
                if inCode { blocks.append(.init(kind: .code, text: code.joined(separator: "\n"))); code = [] }
                inCode.toggle(); continue
            }
            if inCode { code.append(line); continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flush(); continue }
            let heading = line.prefix { $0 == "#" }.count
            if (1...6).contains(heading), line.dropFirst(heading).first == " " {
                flush(); blocks.append(.init(kind: .heading(heading), text: String(line.dropFirst(heading + 1))))
            } else if trimmed == "---" || trimmed == "***" {
                flush(); blocks.append(.init(kind: .divider, text: ""))
            } else if trimmed.hasPrefix("> ") {
                flush(); blocks.append(.init(kind: .quote, text: String(trimmed.dropFirst(2))))
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                flush(); blocks.append(.init(kind: .item, text: "• " + trimmed.dropFirst(2)))
            } else if trimmed.range(of: #"^\d+\. "#, options: .regularExpression) != nil {
                flush(); blocks.append(.init(kind: .item, text: trimmed))
            } else { paragraph.append(line) }
        }
        flush()
        if inCode { blocks.append(.init(kind: .code, text: code.joined(separator: "\n"))) }
        return blocks
    }

    static func inline(_ text: String) -> AttributedString {
        var result = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        // Markdown comes from documents and models. Links may navigate the web;
        // local documents are opened using the separate vetted source buttons.
        for run in result.runs {
            if let link = run.link, !["https", "http"].contains(link.scheme?.lowercased() ?? "") {
                result[run.range].link = nil
            }
        }
        return result
    }
}

struct MarkdownContent: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                switch block.kind {
                case .heading(let level):
                    Text(MarkdownBlock.inline(block.text))
                        .font(level == 1 ? .title : level == 2 ? .title2 : .headline)
                        .fontWeight(.semibold).accessibilityAddTraits(.isHeader)
                case .code:
                    ScrollView(.horizontal) {
                        Text(block.text).font(.system(.body, design: .monospaced)).padding(12)
                    }.background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                case .quote:
                    HStack(alignment: .top, spacing: 12) {
                        RoundedRectangle(cornerRadius: 2).fill(.secondary).frame(width: 3)
                        Text(MarkdownBlock.inline(block.text)).foregroundStyle(.secondary)
                    }.fixedSize(horizontal: false, vertical: true)
                case .item:
                    Text(MarkdownBlock.inline(block.text)).padding(.leading, 8)
                case .divider: Divider()
                case .paragraph: Text(MarkdownBlock.inline(block.text))
                }
            }
        }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                ["http", "https"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
            })
    }
}
