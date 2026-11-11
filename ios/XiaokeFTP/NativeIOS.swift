#if os(iOS)
import UIKit
import QuickLook
import PhotosUI
import UniformTypeIdentifiers

/// iPhone／iPad 才有的原生功能：預覽、分享、從「照片」「檔案」匯入、螢幕不休眠
private var previewURL: URL?
private var importDone: (([URL]) -> Void)?
private var importDir = Native.docs

extension Native {
    // 本機資料夾：App 的「文件」（「檔案」App 裡看得到）
    func places() -> [String: Any] {
        let dl = Self.docs.appendingPathComponent("下載")
        try? FileManager.default.createDirectory(at: dl, withIntermediateDirectories: true)
        return ["places": [["name": "我的檔案", "path": Self.docs.path, "icon": "home"], ["name": "下載", "path": dl.path, "icon": "down"]],
                "drives": [] as [Any], "home": Self.docs.path, "root": ["name": "我的檔案", "path": Self.docs.path]]
    }
    func deleteLocal(_ paths: [String]) throws { for p in paths { try FileManager.default.removeItem(atPath: p) } }
    func keepAwake(_ on: Bool) { DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on } }
    func openExternal(_ u: URL) { DispatchQueue.main.async { UIApplication.shared.open(u) } }
    func pickPaths(title: String, folders: Bool) throws -> Any? { throw XKError("iPhone／iPad 版不支援") }

    func preview(_ url: URL) {
        previewURL = url
        let q = QLPreviewController()
        q.dataSource = self
        web?.present(q)
    }
    func share(_ url: URL) {
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        web?.present(vc)
    }

    // 從「檔案」或「照片」匯入到目前的資料夾
    func importFiles(into dir: String, photos: Bool) throws -> Int {
        let sem = DispatchSemaphore(value: 0)
        var count = 0
        importDir = URL(fileURLWithPath: dir)
        DispatchQueue.main.async {
            importDone = { urls in count = urls.count; sem.signal() }
            if photos {
                var cfg = PHPickerConfiguration(photoLibrary: .shared())
                cfg.selectionLimit = 0
                cfg.preferredAssetRepresentationMode = .current
                let p = PHPickerViewController(configuration: cfg)
                p.delegate = self
                self.web?.present(p)
            } else {
                let p = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
                p.allowsMultipleSelection = true
                p.delegate = self
                self.web?.present(p)
            }
        }
        sem.wait()
        return count
    }
    func copyIn(_ src: URL, name: String? = nil) -> URL? {
        let fm = FileManager.default
        var dst = importDir.appendingPathComponent(name ?? src.lastPathComponent)
        var k = 2
        while fm.fileExists(atPath: dst.path) {
            let base = (dst.lastPathComponent as NSString).deletingPathExtension, ext = (dst.lastPathComponent as NSString).pathExtension
            dst = importDir.appendingPathComponent("\(base.replacingOccurrences(of: " (\(k - 1))", with: "")) (\(k))" + (ext.isEmpty ? "" : ".\(ext)"))
            k += 1
        }
        do { try fm.copyItem(at: src, to: dst); return dst } catch { return nil }
    }
}

extension Native: QLPreviewControllerDataSource {
    func numberOfPreviewItems(in c: QLPreviewController) -> Int { previewURL == nil ? 0 : 1 }
    func previewController(_ c: QLPreviewController, previewItemAt i: Int) -> QLPreviewItem { previewURL! as NSURL }
}

extension Native: UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let out = urls.compactMap { copyIn($0) }
        importDone?(out); importDone = nil
    }
    func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) { importDone?([]); importDone = nil }
    func picker(_ p: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        p.dismiss(animated: true)
        let group = DispatchGroup()
        var out: [URL] = []
        let l = NSLock()
        for r in results {
            let prov = r.itemProvider
            guard let type = prov.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .movie) == true || UTType($0)?.conforms(to: .image) == true }) ?? prov.registeredTypeIdentifiers.first else { continue }
            group.enter()
            prov.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                if let url, let d = self.copyIn(url, name: url.lastPathComponent) { l.lock(); out.append(d); l.unlock() }
                group.leave()
            }
        }
        group.notify(queue: .global()) { importDone?(out); importDone = nil }
    }
}

#endif
