import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class Store: ObservableObject {
    @Published var jobs: [Job] = []
    @Published var error: String?
    @Published var busy = false
    @Published var selectedID: String?
    @Published var pendingFiles: [URL] = []
    @Published var deep = false
    var openWindow: ((String) -> Void)?
    var panelSizeChanged: ((CGSize) -> Void)?
    @Published var repository: String { didSet { UserDefaults.standard.set(repository, forKey: "repository") } }
    @Published var node: String { didSet { UserDefaults.standard.set(node, forKey: "node") } }
    private var refreshing = false
    init() {
        repository = UserDefaults.standard.string(forKey: "repository") ?? Bundle.main.object(forInfoDictionaryKey: "MnemazineRepository") as? String ?? ""
        node = UserDefaults.standard.string(forKey: "node") ?? Bundle.main.object(forInfoDictionaryKey: "MnemazineNode") as? String ?? ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) } ?? ""
    }
    var configured: Bool { !repository.isEmpty && !node.isEmpty }
    var selected: Job? { jobs.first { $0.id == selectedID } }
    func refresh() async {
        guard configured, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do { jobs = try await Backend.run(repository: repository, node: node, args: Backend.arguments("list")).jobs ?? [] }
        catch { self.error = error.localizedDescription }
    }
    func submit(kind: String, query: String? = nil, mode: String = "local", files: [URL] = [], text: String? = nil) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let result = try await Backend.run(repository: repository, node: node, args: Backend.arguments("submit", kind: kind, query: query, mode: mode, files: files, text: text))
            selectedID = result.job?.id
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func action(_ command: String, id: String) async {
        do {
            _ = try await Backend.run(repository: repository, node: node, args: Backend.arguments(command, id: id))
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true; panel.canChooseDirectories = false
        panel.message = "Файлы попадут в очередь Мнемозины. Оригиналы останутся на месте."
        panel.begin { response in
            guard response == .OK else { return }
            Task { @MainActor in self.pendingFiles = panel.urls }
        }
    }
    func chooseRepository() {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.message = "Выбери папку проекта Mnemazine"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in self.repository = url.path; await self.refresh() }
        }
    }
    func chooseNode() {
        let panel = NSOpenPanel(); panel.message = "Выбери исполняемый файл node"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in self.node = url.path; await self.refresh() }
        }
    }
}

@main
struct MnemazineApp: App {
    @NSApplicationDelegateAdaptor(StatusAppDelegate.self) private var delegate
    var body: some Scene {
        Settings { EmptyView() }
    }
}

struct GlassPlate: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency { content.background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 16)) }
        else {
            if #available(macOS 26.0, *) {
                content.background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
                    .glassEffect(.regular, in: .rect(cornerRadius: 16))
            } else { content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) }
        }
    }
}

func fileActionAccessibilityLabel(configured: Bool, pendingCount: Int) -> String {
    if !configured { return "Открыть настройки Мнемозины" }
    if pendingCount > 0 { return "Обработать файлы: \(pendingCount)" }
    return "Добавить файлы: перенеси сюда или нажми для выбора"
}

struct MenuPanel: View {
    @EnvironmentObject var store: Store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var input = ""
    @State private var mode: SpotlightMode = .search
    @State private var clipboard = ClipboardPreview()
    @State private var confirmedRequest: SpotlightRequest?
    @State private var confirmedFiles: [URL] = []
    @State private var confirmExternal = false
    @State private var targeted = false
    @State private var validation: String?
    @State private var panel = MenuPanelWindow()
    @FocusState private var inputFocused: Bool
    @Namespace private var glassNamespace
    var body: some View {
        VStack(spacing: 0) {
            glassHeader
            if mode != .search || validation != nil {
                VStack(alignment: .leading, spacing: 14) {
                    if let validation {
                        Text(validation).font(.callout).foregroundStyle(.red).textSelection(.enabled)
                    }
                    expansion
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                    .modifier(ReadablePlate(cornerRadius: 20)).padding(.top, 12)
                    .transition(.opacity)
            }
        }.frame(width: min(620, (NSScreen.main?.visibleFrame.width ?? 672) - 52))
            .padding(10)
            .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.86), value: targeted)
            .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.86), value: mode)
            .background(GeometryReader { proxy in
                Color.clear.preference(key: SpotlightSizeKey.self, value: proxy.size)
            })
            .onPreferenceChange(SpotlightSizeKey.self) { size in
                guard size.width > 0, size.height > 0 else { return }
                store.panelSizeChanged?(size)
            }
            .background(MenuPanelAnchor(panel: panel).frame(width: 0, height: 0))
            .onAppear { DispatchQueue.main.async { panel.window?.makeKey(); inputFocused = true } }
            .onExitCommand { panel.window?.close() }
            .task { await store.refresh() }
            .dropDestination(for: URL.self) { urls, _ in
                guard !store.busy, !urls.isEmpty, urls.allSatisfy(\.isFileURL) else { return false }
                store.pendingFiles = urls; mode = .files; validation = nil
                return true
            } isTargeted: { targeted = $0 }
            .onChange(of: store.pendingFiles) { _, files in
                if !files.isEmpty { mode = .files; validation = nil }
            }
            .alert("Передать данные для обработки?", isPresented: $confirmExternal) {
                Button("Отмена", role: .cancel) {}
                Button("Отправить и обработать") { sendConfirmed() }
            } message: {
                Text(confirmedRequest?.kind == "ingest" || !confirmedFiles.isEmpty
                     ? "Содержимое будет передано настроенной модели для исследования с вебом. Оригиналы файлов сохранятся. Полный текст страницы и расшифровка видео не гарантируются."
                     : "Провайдер получит запрос и найденные фрагменты памяти.")
            }
    }
    @ViewBuilder private var glassHeader: some View {
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: 6) { headerRow }
        } else { headerRow }
    }
    private var headerRow: some View {
        HStack(spacing: 8) {
            HStack(spacing: 12) {
                if targeted {
                    Image(systemName: "doc.badge.plus").font(.system(size: 28, weight: .light))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Отпусти файл здесь").font(.system(size: 24))
                        Text("Сначала покажу выбранное").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                } else {
                    if mode == .search {
                        Button { select(.search) } label: {
                            Image(systemName: "magnifyingglass").font(.system(size: 24))
                                .foregroundStyle(.secondary)
                        }.buttonStyle(.plain).help("Поиск").accessibilityLabel("Поиск")
                    } else { modeCircle(mode, selected: true) }
                    if case .received(let summary) = SpotlightHeaderContent.resolve(targeted: false, mode: mode, files: store.pendingFiles.map(\.lastPathComponent)) {
                        Text(summary).font(.system(size: 20)).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel("Получены файлы: " + summary)
                    } else {
                        TextField(mode.placeholder, text: $input).textFieldStyle(.plain)
                            .font(.system(size: 26)).focused($inputFocused).onSubmit { performAction() }
                            .disabled(mode == .files || mode == .settings).accessibilityLabel(mode.placeholder)
                    }
                    if store.busy { ProgressView().controlSize(.small) }
                }
            }.padding(.leading, mode == .search || targeted ? 22 : 11).padding(.trailing, 20)
                .frame(maxWidth: .infinity).frame(height: 64)
                .modifier(SpotlightCapsule(id: "search", namespace: glassNamespace))
            if !targeted {
                ForEach(SpotlightGlassLayout.externalModes(selected: mode), id: \.self) { option in
                    modeCircle(option, selected: false)
                }
            }
        }.contextMenu {
            Button("Очередь и результаты") { show("queue") }
            Button("Выйти") { NSApp.terminate(nil) }.keyboardShortcut("q")
        }
    }
    private func modeCircle(_ option: SpotlightMode, selected: Bool) -> some View {
        Button { select(selected ? .search : option) } label: {
            Image(systemName: option.symbol).font(.system(size: 17))
                .frame(width: 42, height: 42).contentShape(Circle())
        }.buttonStyle(.plain)
            .modifier(SpotlightCapsule(id: "mode-" + option.rawValue, namespace: glassNamespace, circle: true))
            .help(selected ? "Вернуться к поиску" : option.rawValue)
            .accessibilityLabel(selected ? option.rawValue + ", вернуться к поиску" : option.rawValue)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
    @ViewBuilder private var expansion: some View {
        switch mode {
        case .search: EmptyView()
        case .link:
            Text("Добавь ссылку, название или короткий текст в строку сверху.").font(.callout).foregroundStyle(.secondary)
            Text("Модель исследует тему с вебом. Получение полного текста страницы или видео не гарантируется.")
                .font(.caption).foregroundStyle(.secondary)
            Button("Исследовать и добавить") { performAction() }.buttonStyle(.borderedProminent).disabled(store.busy || input.isEmpty)
        case .files:
            filePreview
        case .clipboard:
            if !clipboard.files.isEmpty {
                Text("Файлы из буфера").font(.headline)
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(clipboard.files, id: \.self) { file in
                            Label(file.lastPathComponent, systemImage: "doc").lineLimit(1)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 115)
            } else if !clipboard.text.isEmpty {
                Text("Прочитано по нажатию «Буфер»").font(.caption).foregroundStyle(.secondary)
                ScrollView { Text(clipboard.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 100)
            } else { Text("В буфере нет текста или файлов.").foregroundStyle(.secondary) }
            HStack {
                Button("Прочитать снова") { select(.clipboard) }
                Spacer()
                Button("Добавить в память") { performAction() }.buttonStyle(.borderedProminent)
                    .disabled(store.busy || (clipboard.files.isEmpty && input.isEmpty))
            }
        case .settings:
            SettingsView(embedded: true).frame(height: 390)
        }
    }
    private var filePreview: some View {
        VStack(alignment: .leading, spacing: 12) {
            if store.pendingFiles.isEmpty {
                Label("Перенеси файлы в это окно", systemImage: "tray.and.arrow.down").font(.headline)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(store.pendingFiles, id: \.self) { file in
                            Label(file.lastPathComponent, systemImage: "doc").lineLimit(1).help(file.path)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 115)
                Text("Оригиналы останутся на месте.").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button("Выбрать файлы…") { store.chooseFiles() }.keyboardShortcut("o")
                if !store.pendingFiles.isEmpty {
                    Button("Убрать") { store.pendingFiles = [] }
                    Spacer()
                    Button("Обработать") { performAction() }.buttonStyle(.borderedProminent).disabled(store.busy)
                }
            }
        }
    }
    private func select(_ option: SpotlightMode) {
        mode = option; validation = nil
        if let preview = ClipboardPreview.onSelection(option, read: {
            let pasteboard = NSPasteboard.general
            let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
            return ClipboardPreview(text: urls.isEmpty ? pasteboard.string(forType: .string) ?? pasteboard.string(forType: .URL) ?? "" : "", files: urls)
        }) {
            clipboard = preview
            input = preview.text
        }
        if option != .files && option != .settings { inputFocused = true }
    }
    private func performAction() {
        guard !store.busy else { return }
        guard store.configured else { mode = .settings; return }
        validation = nil
        let files = mode == .files ? store.pendingFiles : mode == .clipboard ? clipboard.files : []
        if !files.isEmpty {
            confirmedFiles = files; confirmedRequest = nil; confirmExternal = true; return
        }
        guard let request = SpotlightRequest.resolve(mode: mode, input: input) else {
            if input.utf8.count > 8192 { validation = "Текст больше 8 КиБ. Сохрани его в файл и добавь через «Файлы»." }
            return
        }
        confirmedFiles = []; confirmedRequest = request
        if request.kind == "ingest" || store.deep { confirmExternal = true }
        else { sendConfirmed() }
    }
    private func sendConfirmed() {
        let files = confirmedFiles, request = confirmedRequest
        let executionMode = !files.isEmpty || request?.kind == "ingest" || store.deep ? "deep" : "local"
        Task {
            if !files.isEmpty { await store.submit(kind: "ingest", mode: "deep", files: files) }
            else if let request { await store.submit(kind: request.kind, query: request.query, mode: executionMode, text: request.text) }
            else { return }
            if store.error == nil && !files.isEmpty { store.pendingFiles = [] }
            show(store.error == nil && files.isEmpty && request?.kind != "ingest" ? "result" : "queue")
        }
    }
    private func show(_ id: String) { panel.window?.close(); store.openWindow?(id) }
}

private struct SpotlightSizeKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}
struct SearchRequest: Equatable {
    let kind: String
    let query: String
    static func parse(_ input: String) -> SearchRequest {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = "сделай справку"
        let lower = text.lowercased()
        if lower == prefix || lower.hasPrefix(prefix + " ") || lower.hasPrefix(prefix + ":") || lower.hasPrefix(prefix + "\n") {
            let topic = String(text.dropFirst(prefix.count)).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ":")))
            return .init(kind: "brief", query: topic.isEmpty ? text : topic)
        }
        return .init(kind: "search", query: text)
    }
}

struct QueueView: View {
    @EnvironmentObject var store: Store
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Очередь").font(.title2.weight(.semibold))
                Spacer()
                Button { Task { await store.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Обновить очередь")
            }.padding(12).modifier(ReadablePlate())
            if let error = store.error {
                HStack {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                    Button("Скрыть") { store.error = nil }
                }.padding(12).modifier(GlassPlate())
            }
            if store.jobs.isEmpty {
                ContentUnavailableView("Пока нет задач", systemImage: "tray", description: Text("Добавь файлы или задай вопрос через значок в строке меню."))
                    .modifier(ReadablePlate())
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(store.jobs.sorted { ($0.created_at ?? "") > ($1.created_at ?? "") }.prefix(20))) { job in
                            HStack(spacing: 0) {
                                Button {
                                    store.selectedID = job.id; store.openWindow?("result")
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(job.title).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                                        Text(job.statusLabel).font(.caption).foregroundStyle(.secondary)
                                        if let error = job.error { Text(error.message).font(.caption).foregroundStyle(.red).lineLimit(3) }
                                    }.padding(14).contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityLabel("\(job.title), \(job.statusLabel), открыть")
                                    .accessibilityValue(job.error?.message ?? "")
                                if job.active {
                                    Button("Отменить") { Task { await store.action("cancel", id: job.id) } }
                                        .padding(.trailing, 14)
                                } else if ["failed", "cancelled"].contains(job.status) {
                                    Button("Повторить") { Task { await store.action("retry", id: job.id) } }
                                        .padding(.trailing, 14)
                                }
                            }.modifier(GlassPlate())
                        }
                    }
                }
            }
        }.padding(22).frame(minWidth: 460, minHeight: 320)
            .modifier(GlassWindow())
            .task {
                while !Task.isCancelled {
                    await store.refresh()
                    try? await Task.sleep(for: .seconds(2))
                }
            }
    }
}
@MainActor
final class MenuPanelWindow {
    weak var window: NSWindow?
}

struct MenuPanelAnchor: NSViewRepresentable {
    let panel: MenuPanelWindow
    func makeNSView(context: Context) -> NSView { Anchor(panel: panel) }
    func updateNSView(_ nsView: NSView, context: Context) {}
    private final class Anchor: NSView {
        let panel: MenuPanelWindow
        init(panel: MenuPanelWindow) { self.panel = panel; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError("Use init(panel:)") }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            panel.window = window
            window?.isReleasedWhenClosed = false
            // MenuBarExtra owns a nonactivating NSPanel. Make it key without
            // activating the whole app so normal typing reaches the search field.
            if window?.isVisible == true { window?.makeKey() }
        }
    }
}

struct ResultView: View {
    @EnvironmentObject var store: Store
    var body: some View {
        Group {
            if let job = store.selected {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(job.title).font(.title2).textSelection(.enabled)
                        Text(job.statusLabel).foregroundStyle(.secondary)
                        if let error = job.error { Text(error.message).foregroundStyle(.red).textSelection(.enabled) }
                        if let text = job.result?.text { MarkdownContent(text: text) }
                        if let report = job.result?.report_path, report.hasPrefix("/") {
                            Button("Открыть справку") { NSWorkspace.shared.open(URL(fileURLWithPath: report)) }
                        }
                        if let sources = job.result?.sources, !sources.isEmpty {
                            Divider(); Text("Источники").font(.headline)
                            ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
                                if let url = source.target {
                                    Button(source.title ?? source.path ?? source.url ?? "Источник") { NSWorkspace.shared.open(url) }
                                } else { Text(source.title ?? "Источник без ссылки") }
                            }
                        }
                        if job.active { ProgressView("Задача продолжается. Окно можно закрыть.") }
                    }.padding(20).modifier(ReadablePlate(cornerRadius: 16)).padding(20)
                }
            } else { ContentUnavailableView("Выбери задачу", systemImage: "doc.text.magnifyingglass", description: Text("Открой результат из очереди в строке меню.")).modifier(ReadablePlate()).padding(20) }
        }.frame(minWidth: 500, minHeight: 350)
            .modifier(GlassWindow())
            .task {
                while !Task.isCancelled {
                    await store.refresh()
                    try? await Task.sleep(for: .seconds(2))
                }
            }
    }
}

struct SettingsView: View {
    var embedded = false
    @EnvironmentObject var store: Store
    @State private var providers: [CLIProvider] = []
    @State private var providerError: String?
    @ViewBuilder var body: some View {
        if embedded { settingsContent }
        else { settingsContent.modifier(GlassWindow()) }
    }
    private var settingsContent: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 20) {
            Text("Настройки").font(.title2.weight(.semibold))
            LabeledContent("Папка Mnemazine") {
                VStack(alignment: .leading) {
                    Text(store.repository.isEmpty ? "Не выбрана" : store.repository)
                        .font(.caption).lineLimit(2).truncationMode(.middle)
                        .textSelection(.enabled).help(store.repository)
                    Button("Выбрать папку…") { store.chooseRepository() }
                }
            }
            LabeledContent("Node.js") {
                VStack(alignment: .leading) {
                    Text(store.node.isEmpty ? "Не найден" : store.node)
                        .font(.caption).lineLimit(2).truncationMode(.middle)
                        .textSelection(.enabled).help(store.node)
                    Button("Выбрать Node.js…") { store.chooseNode() }
                }
            }
            Toggle("Глубокий поиск с AI", isOn: $store.deep)
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Установленные CLI").font(.headline)
                    Spacer()
                    Button("Обновить") { Task { await refreshProviders() } }
                }
                ForEach(providers) { provider in
                    HStack {
                        Text(provider.name)
                        Spacer()
                        Text(provider.status).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let providerError { Text(providerError).font(.caption).foregroundStyle(.red) }
                Text("При лимите используется следующий разрешённый CLI. Неизвестные программы без адаптера не запускаются. Доступность модели и авторизация проверяются при работе.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text("Перед каждым AI-запросом появится подтверждение передачи запроса и фрагментов памяти. После перезапуска поиск снова локальный.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text("Обработка файлов использует настроенный pipeline Mnemazine и может обращаться к внешним AI-сервисам. Поиск по умолчанию локальный.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(20).modifier(ReadablePlate(cornerRadius: 16)).padding(20)
        }.frame(minWidth: embedded ? 0 : 520, minHeight: embedded ? 0 : 420)
            .task { await refreshProviders() }
    }
    func refreshProviders() async {
        do {
            providers = try await Backend.run(repository: store.repository, node: store.node,
                                              args: ["scripts/mnemazine-cli-discover.mjs"]).providers ?? []
            providerError = nil
        } catch { providerError = error.localizedDescription }
    }
}
