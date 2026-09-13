import XCTest
@testable import Mnemazine

final class BackendTests: XCTestCase {
    func testTextIntakeArgumentsAndSnapshotWithoutOriginal() throws {
        let input = "https://www.youtube.com/watch?v=abc&list=123"
        XCTAssertEqual(Backend.arguments("submit", kind: "ingest", mode: "deep", text: input),
                       ["scripts/mnemazine-jobs.mjs", "submit", "--kind", "ingest", "--text", input, "--mode", "deep"])
        let data = Data(#"{"job":{"id":"url-job","kind":"ingest","status":"queued","input_text":"Название видео","files":[{"name":"research-request.md","snapshot":"/tmp/source.md"}]}}"#.utf8)
        let job = try JSONDecoder().decode(Envelope.self, from: data).job!
        XCTAssertEqual(job.title, "Название видео")
        XCTAssertNil(job.files?.first?.original)
    }
    func testArgumentsKeepUntrustedTextAsSingleArgument() {
        let query = "строка с пробелом; $(touch /tmp/no)\nещё"
        XCTAssertEqual(Backend.arguments("submit", kind: "brief", query: query),
                       ["scripts/mnemazine-jobs.mjs", "submit", "--kind", "brief", "--query", query, "--mode", "local"])
        XCTAssertEqual(Backend.arguments("submit", kind: "ingest", mode: "deep", files: [URL(fileURLWithPath: "/tmp/мой файл.pdf")]).suffix(4),
                       ["--mode", "deep", "--file", "/tmp/мой файл.pdf"])
    }
    func testCompletedAndFailedEnvelopes() throws {
        let data = Data(#"{"jobs":[{"id":"a","kind":"brief","status":"completed","result":{"text":"ответ","sources":["/tmp/a.md",{"title":"web","url":"https://example.com"}]}},{"id":"b","kind":"ingest","status":"failed","files":[{"name":"файл.pdf","original":"/tmp/файл.pdf","snapshot":"/tmp/job/файл.pdf","sha256":"abc"}],"error":{"message":"отказ","code":3}}]}"#.utf8)
        let jobs = try JSONDecoder().decode(Envelope.self, from: data).jobs!
        XCTAssertEqual(jobs[0].result?.sources?.first?.target?.path, "/tmp/a.md")
        XCTAssertEqual(jobs[1].error?.message, "отказ")
        XCTAssertFalse(jobs[1].active)
        XCTAssertEqual(jobs[1].title, "файл.pdf")
        let unsafe = try JSONDecoder().decode(Source.self, from: Data(#"{"url":"file:///etc/passwd"}"#.utf8))
        XCTAssertNil(unsafe.target)
        let executable = try JSONDecoder().decode(Source.self, from: Data(#"{"path":"/tmp/run.command"}"#.utf8))
        XCTAssertNil(executable.target)
    }
}
