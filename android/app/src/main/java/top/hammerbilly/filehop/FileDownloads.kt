package top.hammerbilly.filehop

import android.app.Application
import android.net.Uri
import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

enum class DownloadStage { Idle, Choosing, Waiting, Downloading, Saving, Cancelling, Cleaning }
data class DownloadScreen(
    val stage: DownloadStage = DownloadStage.Idle,
    val bytes: Long = 0,
    val total: Long = 0,
    val pickerOpen: Boolean = false,
    val cleanupBlocked: Boolean = false,
    @StringRes val noticeRes: Int? = null,
) {
    val busy: Boolean get() = pickerOpen || stage != DownloadStage.Idle
    val canStart: Boolean get() = !busy && !cleanupBlocked
}

/** In-process download lane only; upload and text operations do not acquire this slot. */
class FileDownloads(
    application: Application,
    private val scope: CoroutineScope,
    private val authenticationInvalid: () -> Unit,
) {
    private val resolver = application.contentResolver
    private val directory = File(application.cacheDir, "file-downloads")
    var screen by mutableStateOf(DownloadScreen())
        private set
    private data class Selection(val message: Message, val origin: String, val token: String, val target: Uri? = null)
    private var selection: Selection? = null
    private var active: FileDownloadTransfer? = null
    private var foreground = false
    private var generation = 0L
    private var cleanups = 0

    init { retryCleanup() }

    fun retryCleanup() {
        if (screen.busy || active != null || selection != null) return
        cleanups++
        screen = screen.copy(stage = DownloadStage.Cleaning)
        scope.launch {
            val (clean, recovered) = withContext(Dispatchers.IO) {
                val recovered = runCatching { directory.listFiles()?.isNotEmpty() == true }.getOrDefault(false)
                cleanDownloadDirectory(directory) to recovered
            }
            cleanups--
            screen = screen.copy(stage = if (cleanups == 0) DownloadStage.Idle else DownloadStage.Cleaning,
                cleanupBlocked = !clean, noticeRes = when {
                    !clean -> R.string.download_temporary_cleanup_failed
                    recovered -> R.string.download_recovered_check_target
                    else -> null
                })
        }
    }

    fun choose(message: Message, origin: String, token: String): Boolean {
        if (!foreground || !screen.canStart || message.kind != "FILE" || message.fileState != "available") return false
        selection = Selection(message, origin, token)
        screen = DownloadScreen(stage = DownloadStage.Choosing, pickerOpen = true)
        return true
    }

    fun pickerReturned(target: Uri?, launchFailed: Boolean = false) {
        val selected = selection
        screen = screen.copy(pickerOpen = false)
        if (selected == null) {
            // Includes a late result after logout/expiry, or after process recreation. Never download it.
            if (target != null) discardTarget(target)
            else if (active == null) screen = screen.copy(stage = if (cleanups == 0) DownloadStage.Idle else DownloadStage.Cleaning)
            return
        }
        if (target == null) {
            selection = null
            screen = screen.copy(stage = DownloadStage.Idle,
                noticeRes = if (launchFailed) R.string.download_picker_failed else null)
            return
        }
        selection = selected.copy(target = target)
        screen = screen.copy(stage = DownloadStage.Waiting, total = selected.message.fileSize)
        startIfReady()
    }

    fun foreground(visible: Boolean) {
        foreground = visible
        if (visible) startIfReady()
    }

    private fun startIfReady() {
        val selected = selection ?: return
        val target = selected.target ?: return
        if (!foreground || active != null) return
        selection = null
        val epoch = generation
        lateinit var transfer: FileDownloadTransfer
        transfer = FileDownloadTransfer(resolver, directory, selected.origin, selected.token, selected.message, target,
            closeAsync = { descriptor -> scope.launch(NonCancellable + Dispatchers.IO) { runCatching { descriptor.close() } }; Unit },
            progress = { stage, bytes ->
                scope.launch {
                    if (active === transfer && generation == epoch && screen.stage != DownloadStage.Cancelling)
                        screen = screen.copy(stage = stage, bytes = bytes)
                }
            })
        active = transfer
        screen = screen.copy(stage = DownloadStage.Downloading, bytes = 0)
        // Explicit cancellation closes the call/provider, but cannot skip the worker's finally cleanup.
        scope.launch(NonCancellable) {
            val result = withContext(Dispatchers.IO) { transfer.run() }
            if (active !== transfer) return@launch
            active = null
            screen = screen.copy(stage = DownloadStage.Idle, bytes = 0, total = 0,
                cleanupBlocked = result.temporaryCleanupFailed,
                noticeRes = when {
                    result.saved && result.temporaryCleanupFailed -> R.string.download_saved_cleanup_failed
                    result.saved -> R.string.download_saved
                    result.temporaryCleanupFailed -> R.string.download_failed_cleanup_failed
                    result.cancelled -> R.string.download_cancelled_check_target
                    result.insufficientSpace -> R.string.download_space_failed
                    else -> R.string.download_failed_check_target
                })
            if (result.unauthorized && generation == epoch) authenticationInvalid()
        }
    }

    fun cancel() {
        active?.let { transfer ->
            transfer.cancel()
            scope.launch(NonCancellable + Dispatchers.IO) { runCatching { transfer.cancelProvider() } }
            screen = screen.copy(stage = DownloadStage.Cancelling)
            return
        }
        val target = selection?.target
        selection = null
        if (target != null) discardTarget(target)
    }

    fun invalidate() {
        generation++
        val unfinished = active != null || selection != null || screen.pickerOpen
        cancel()
        // Keep the picker guard until its callback returns, but drop its message and old credentials.
        selection = null
        screen = screen.copy(bytes = 0, total = 0,
            noticeRes = if (unfinished) R.string.download_cancelled_check_target else screen.noticeRes)
    }

    private fun discardTarget(target: Uri) {
        cleanups++
        screen = screen.copy(stage = DownloadStage.Cleaning)
        scope.launch(NonCancellable) {
            withContext(Dispatchers.IO) { removeDownloadTarget(resolver, target) }
            cleanups--
            screen = screen.copy(stage = if (cleanups == 0) DownloadStage.Idle else DownloadStage.Cleaning, bytes = 0, total = 0,
                noticeRes = R.string.download_cancelled_check_target)
        }
    }
}
