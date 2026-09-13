// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Mnemazine", platforms: [.macOS(.v14)],
    products: [.executable(name: "Mnemazine", targets: ["Mnemazine"])],
    targets: [.executableTarget(name: "Mnemazine"),
              .testTarget(name: "MnemazineTests", dependencies: ["Mnemazine"])])
