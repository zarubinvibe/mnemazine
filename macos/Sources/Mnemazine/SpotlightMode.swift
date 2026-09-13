import Foundation

enum SpotlightGlassLayout {
    static func externalModes(selected: SpotlightMode) -> [SpotlightMode] {
        [.link, .files, .clipboard, .settings].filter { $0 != selected }
    }
}

enum SpotlightHeaderContent: Equatable {
    case input, drop, received(String)
    static func resolve(targeted: Bool, mode: SpotlightMode, files: [String]) -> SpotlightHeaderContent {
        if targeted { return .drop }
        guard mode == .files, let first = files.first else { return .input }
        return .received(files.count == 1 ? first : "\(first) и ещё \(files.count - 1)")
    }
}

enum SpotlightMode: String, CaseIterable {
    case search = "Поиск", link = "Ссылка", files = "Файлы", clipboard = "Буфер", settings = "Настройки"
    var symbol: String {
        switch self {
        case .search: return "magnifyingglass"
        case .link: return "link"
        case .files: return "folder"
        case .clipboard: return "doc.on.clipboard"
        case .settings: return "gearshape"
        }
    }
    var placeholder: String {
        switch self {
        case .search: return "Поиск в памяти"
        case .link: return "Ссылка или название"
        case .files: return "Добавить файлы"
        case .clipboard: return "Текст из буфера"
        case .settings: return "Настройки Мнемозины"
        }
    }
}

struct ClipboardPreview: Equatable {
    var text: String = ""
    var files: [URL] = []
    static func onSelection(_ mode: SpotlightMode, read: () -> ClipboardPreview) -> ClipboardPreview? {
        mode == .clipboard ? read() : nil
    }
}

struct SpotlightRequest: Equatable {
    let kind: String
    var query: String? = nil
    var text: String? = nil
    static func resolve(mode: SpotlightMode, input: String) -> SpotlightRequest? {
        let input = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return nil }
        switch mode {
        case .search:
            let search = SearchRequest.parse(input)
            return .init(kind: search.kind, query: search.query)
        case .link, .clipboard:
            guard input.utf8.count <= 8192 else { return nil }
            return .init(kind: "ingest", text: input)
        case .files, .settings: return nil
        }
    }
}
