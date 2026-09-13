import AppKit

enum MnemazineMark {
    static func image() -> NSImage {
        // Approved option 5: eight nodes and nine bonds, extended horizontally.
        let image = NSImage(size: NSSize(width: 32, height: 18), flipped: false) { _ in
            let nodes: [NSPoint] = [.init(x: 3, y: 13), .init(x: 3, y: 5),
                                   .init(x: 9, y: 9), .init(x: 17, y: 13),
                                   .init(x: 17, y: 5), .init(x: 24, y: 9),
                                   .init(x: 29, y: 13), .init(x: 29, y: 5)]
            NSColor.black.setStroke()
            let links = NSBezierPath()
            links.lineWidth = 1
            links.lineCapStyle = .round
            for (a, b) in [(0, 2), (1, 2), (2, 3), (2, 4), (3, 4),
                           (3, 6), (4, 5), (5, 6), (5, 7)] {
                links.move(to: nodes[a]); links.line(to: nodes[b])
            }
            links.stroke()
            NSColor.black.setFill()
            for node in nodes {
                let radius: CGFloat = 1.5
                NSBezierPath(ovalIn: NSRect(x: node.x - radius, y: node.y - radius,
                                           width: radius * 2, height: radius * 2)).fill()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Мнемозина: граф памяти"
        return image
    }
}
