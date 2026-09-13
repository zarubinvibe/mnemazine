import Foundation

struct Job: Decodable, Identifiable, Sendable {
    let id: String
    let kind: String
    let status: String
    var query: String?
    var input_text: String?
    var files: [JobFile]?
    var result: JobResult?
    var error: JobError?
    var created_at: String?
    var title: String { input_text ?? query ?? files?.map(\.name).joined(separator: ", ") ?? kind }
    var active: Bool { status == "queued" || status == "running" }
    var statusLabel: String {
        ["queued": "В очереди", "running": "Обрабатываю", "completed": "Готово",
         "failed": "Не получилось", "cancelled": "Отменено"][status] ?? status
    }
}

struct JobFile: Decodable, Sendable {
    let name: String
    let original: String?
    let snapshot: String?
}

struct JobError: Decodable, Sendable {
    let message: String
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) { message = text }
        else {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            message = try fields.decodeIfPresent(String.self, forKey: .message) ?? "Ошибка обработки"
        }
    }
    enum CodingKeys: String, CodingKey { case message }
}

struct JobResult: Decodable, Sendable {
    var text: String?
    var report_path: String?
    var sources: [Source]?
}

struct Source: Decodable, Sendable {
    var title: String?
    var path: String?
    var url: String?
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            title = string; path = string.hasPrefix("/") ? string : nil
            url = string.hasPrefix("https://") || string.hasPrefix("http://") ? string : nil
        } else {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            title = try fields.decodeIfPresent(String.self, forKey: .title)
            path = try fields.decodeIfPresent(String.self, forKey: .path)
            url = try fields.decodeIfPresent(String.self, forKey: .url)
        }
    }
    enum CodingKeys: String, CodingKey { case title, path, url }
    var target: URL? {
        if let path, path.hasPrefix("/") {
            let target = URL(fileURLWithPath: path)
            guard ["md", "markdown", "txt", "pdf", "docx", "rtf", "csv", "json", "png", "jpg", "jpeg"].contains(target.pathExtension.lowercased()) else { return nil }
            return target
        }
        guard let url, let target = URL(string: url), ["https", "http"].contains(target.scheme) else { return nil }
        return target
    }
}

struct Envelope: Decodable, Sendable {
    var job: Job?
    var jobs: [Job]?
    var providers: [CLIProvider]?
}

struct CLIProvider: Decodable, Identifiable, Sendable {
    let name: String
    let installed: Bool
    let supported: Bool
    var cooldown: CLICooldown?
    var id: String { name }
    var status: String {
        if !installed { return "Не установлен" }
        if !supported { return "Нужен адаптер" }
        if let cooldown {
            return "Лимит до " + Date(timeIntervalSince1970: cooldown.until / 1000).formatted(date: .omitted, time: .shortened)
        }
        return "Найден · вход проверится при вызове"
    }
}
struct CLICooldown: Decodable, Sendable { let reason: String; let until: Double }

enum Backend {
    static func arguments(_ command: String, kind: String? = nil, query: String? = nil,
                          mode: String = "local", files: [URL] = [], id: String? = nil, text: String? = nil) -> [String] {
        var args = ["scripts/mnemazine-jobs.mjs", command]
        if let kind { args += ["--kind", kind] }
        if let query { args += ["--query", query] }
        if let text { args += ["--text", text] }
        if command == "submit" { args += ["--mode", mode] }
        for file in files { args += ["--file", file.path] }
        if let id { args += ["--id", id] }
        return args
    }

    // Process and both pipe readers live off the main actor. Drain stderr in parallel:
    // a verbose child must never fill its pipe and deadlock the menu.
    static func run(repository: String, node: String, args: [String]) async throws -> Envelope {
        try await Task.detached {
            guard FileManager.default.fileExists(atPath: repository + "/scripts/mnemazine-jobs.mjs") else {
                throw NSError(domain: "Mnemazine", code: 1, userInfo: [NSLocalizedDescriptionKey: "Выбери папку Mnemazine в настройках."])
            }
            guard node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: node) else {
                throw NSError(domain: "Mnemazine", code: 2, userInfo: [NSLocalizedDescriptionKey: "Node.js не найден. Выбери исполняемый файл в настройках."])
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = args
            process.currentDirectoryURL = URL(fileURLWithPath: repository)
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = URL(fileURLWithPath: node).deletingLastPathComponent().path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
            process.environment = env
            let output = Pipe(), errors = Pipe()
            process.standardOutput = output; process.standardError = errors
            process.standardInput = FileHandle.nullDevice
            try process.run()
            let timeout = Task.detached {
                try? await Task.sleep(for: .seconds(30))
                if !Task.isCancelled, process.isRunning { process.terminate() }
            }
            defer { timeout.cancel() }
            let errorRead = Task.detached { errors.fileHandleForReading.readDataToEndOfFile() }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let errorData = await errorRead.value
            guard process.terminationStatus == 0 else {
                let message = String(data: errorData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                throw NSError(domain: "Mnemazine", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: message?.isEmpty == false ? message! : "Команда завершилась с ошибкой \(process.terminationStatus)"])
            }
            return try JSONDecoder().decode(Envelope.self, from: data)
        }.value
    }
}
