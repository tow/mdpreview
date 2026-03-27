import Foundation

final class FileWatcher {
    var onChange: (() -> Void)?

    private var source: DispatchSourceFileSystemObject?
    private var fileDescriptor: Int32 = -1
    private var watchedURL: URL?

    func watch(url: URL) {
        stop()
        watchedURL = url
        openAndWatch(url: url)
    }

    func stop() {
        source?.cancel()
        source = nil
        if fileDescriptor >= 0 {
            close(fileDescriptor)
            fileDescriptor = -1
        }
        watchedURL = nil
    }

    private func openAndWatch(url: URL) {
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else { return }
        fileDescriptor = fd

        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: DispatchQueue.global(qos: .utility)
        )

        src.setEventHandler { [weak self] in
            guard let self else { return }
            let flags = src.data
            DispatchQueue.main.async {
                if flags.contains(.write) {
                    self.onChange?()
                } else {
                    // rename/delete — editor may have replaced the file; re-establish watch
                    self.source?.cancel()
                    self.source = nil
                    close(self.fileDescriptor)
                    self.fileDescriptor = -1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        guard let url = self.watchedURL else { return }
                        self.openAndWatch(url: url)
                        self.onChange?()
                    }
                }
            }
        }

        src.setCancelHandler {
            close(fd)
        }

        source = src
        src.resume()
    }

    deinit {
        source?.cancel()
        if fileDescriptor >= 0 { close(fileDescriptor) }
    }
}
