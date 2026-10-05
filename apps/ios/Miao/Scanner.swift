import SwiftUI
import AVFoundation
import VisionKit

@MainActor
struct ScannerView: View {
    let scanned: (String) -> Void
    let manual: () -> Void
    @State private var allowed = false
    @State private var checked = false
    var body: some View {
        Group {
            if allowed && DataScannerViewController.isAvailable {
                Scanner(scanned: scanned).ignoresSafeArea()
            } else {
                ContentUnavailableView {
                    Label("扫码接入", systemImage: "qrcode.viewfinder")
                } description: {
                    Text(checked ? "当前无法使用相机扫描，也可以粘贴电脑上的配对链接。" : "正在准备相机…")
                } actions: { Button("粘贴配对链接", action: manual).buttonStyle(.borderedProminent) }
            }
        }
        .task {
            if DataScannerViewController.isSupported { allowed = await AVCaptureDevice.requestAccess(for: .video) }
            checked = true
        }
    }
}

private struct Scanner: UIViewControllerRepresentable {
    let scanned: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(scanned: scanned) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let view = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
            recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true,
            isGuidanceEnabled: true, isHighlightingEnabled: true)
        view.delegate = context.coordinator
        try? view.startScanning()
        return view
    }
    func updateUIViewController(_ view: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ view: DataScannerViewController, coordinator: Coordinator) { view.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let scanned: (String) -> Void
        private var submitted = false
        init(scanned: @escaping (String) -> Void) { self.scanned = scanned }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !submitted else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let value = barcode.payloadStringValue, value.hasPrefix("miao://pair#") {
                    submitted = true; scanner.stopScanning(); scanned(value); return
                }
            }
        }
    }
}
