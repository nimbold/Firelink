import Foundation
import AppKit
import Sparkle

class InlineUpdateUserDriver: NSObject, SPUUserDriver {
    weak var updater: SparkleUpdater?
    
    init(updater: SparkleUpdater) {
        self.updater = updater
    }
    
    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
    }
    
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        DispatchQueue.main.async {
            self.updater?.resetState()
            self.updater?.isChecking = true
            self.updater?.updateStatus = "Checking for updates..."
            self.updater?.cancellation = cancellation
        }
    }
    
    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        DispatchQueue.main.async {
            self.updater?.isChecking = false
            self.updater?.foundUpdateItem = appcastItem
            self.updater?.updateStatus = "Update available: Version \(appcastItem.displayVersionString)"
            self.updater?.updateChoiceReply = reply
        }
    }
    
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
        DispatchQueue.main.async {
            if let htmlString = String(data: downloadData.data, encoding: .utf8) {
                self.updater?.releaseNotes = self.stripHTML(htmlString)
            }
        }
    }
    
    private func stripHTML(_ string: String) -> String {
        guard let data = string.data(using: .utf8) else { return string }
        if let attributedString = try? NSAttributedString(data: data, options: [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue], documentAttributes: nil) {
            return attributedString.string.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return string
    }
    
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {
    }
    
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        DispatchQueue.main.async {
            self.updater?.isChecking = false
            let nsError = error as NSError
            if nsError.domain == SUSparkleErrorDomain && nsError.code == 1001 {
                self.updater?.updateStatus = "You're up to date!"
            } else {
                self.updater?.updateStatus = "Update check failed: \(error.localizedDescription)"
            }
            acknowledgement()
        }
    }
    
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        DispatchQueue.main.async {
            self.updater?.isChecking = false
            self.updater?.updateStatus = "Updater error: \(error.localizedDescription)"
            acknowledgement()
        }
    }
    
    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        DispatchQueue.main.async {
            self.updater?.isDownloading = true
            self.updater?.downloadProgress = 0.0
            self.updater?.cancellation = cancellation
            self.updater?.updateStatus = "Downloading update..."
        }
    }
    
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        DispatchQueue.main.async {
            self.updater?.expectedContentLength = expectedContentLength
            self.updater?.receivedContentLength = 0
        }
    }
    
    func showDownloadDidReceiveData(ofLength length: UInt64) {
        DispatchQueue.main.async {
            if let updater = self.updater {
                updater.receivedContentLength += length
                if updater.expectedContentLength > 0 {
                    updater.downloadProgress = Double(updater.receivedContentLength) / Double(updater.expectedContentLength)
                }
            }
        }
    }
    
    func showDownloadDidStartExtractingUpdate() {
        DispatchQueue.main.async {
            self.updater?.isDownloading = false
            self.updater?.isExtracting = true
            self.updater?.updateStatus = "Extracting update..."
            self.updater?.downloadProgress = 1.0
        }
    }
    
    func showExtractionReceivedProgress(_ progress: Double) {
        DispatchQueue.main.async {
            self.updater?.extractionProgress = progress
        }
    }
    
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        DispatchQueue.main.async {
            self.updater?.isExtracting = false
            self.updater?.isReadyToInstall = true
            self.updater?.updateStatus = "Ready to install"
            self.updater?.updateChoiceReply = reply
        }
    }
    
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
    }
    
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        acknowledgement()
    }
    
    func dismissUpdateInstallation() {
        DispatchQueue.main.async {
            self.updater?.isChecking = false
            self.updater?.isDownloading = false
            self.updater?.isExtracting = false
            self.updater?.isReadyToInstall = false
            self.updater?.downloadProgress = 0.0
            self.updater?.extractionProgress = 0.0
            self.updater?.foundUpdateItem = nil
            self.updater?.releaseNotes = nil
            // Do not clear updateStatus here so success/error messages remain visible.
        }
    }
    
    func showUpdateInFocus() {
    }
}
