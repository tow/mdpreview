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
        // Cancel handler closes the fd; don't close it here or we race.
        source?.cancel()
        source = nil
        fileDescriptor = -1
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
                    // rename/delete — editor may have replaced the file; re-establish watch.
                    // Don't close fd manually; the cancel handler owns it. Closing here
                    // races with the async cancel handler and can close a freshly-opened fd.
                    self.source?.cancel()
                    self.source = nil
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
    }
}
