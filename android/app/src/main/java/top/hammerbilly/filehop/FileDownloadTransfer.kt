package top.hammerbilly.filehop

import android.content.ContentResolver
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.util.UUID
import java.util.concurrent.TimeUnit

// A newly created Activity must not sweep a previous ViewModel's still-closing worker files.
private val downloadDirectoryLock = Any()

internal data class DownloadResult(
    val saved: Boolean,
    val cancelled: Boolean,
    val unauthorized: Boolean,
    val temporaryCleanupFailed: Boolean,
    val insufficientSpace: Boolean,
)

/** One blocking download/save. Cancellation remains live until the system output has closed. */
internal class FileDownloadTransfer(
    private val resolver: ContentResolver,
    private val directory: File,
    private val origin: String,
    private val token: String,
    private val message: Message,
    private val target: Uri,
    private val closeAsync: (ParcelFileDescriptor) -> Unit,
    private val progress: (DownloadStage, Long) -> Unit,
) {
    private val lock = Any()
    private val signal = CancellationSignal()
    private var call: Call? = null
    private var descriptor: ParcelFileDescriptor? = null
    @Volatile private var cancelled = false
    private var saved = false

    fun cancel() {
        val output = synchronized(lock) {
            if (saved) return
            cancelled = true
            call?.cancel()
            descriptor
        }
        // Providers may block in cancellation/close; never run these on the main thread.
        output?.let(closeAsync)
    }

    fun cancelProvider() { signal.cancel() }
    private fun checkCancellation() { if (cancelled) throw InterruptedIOException() }

    fun run(): DownloadResult = synchronized(downloadDirectoryLock) {
        var temporary: File? = null
        var unauthorized = false
        var insufficientSpace = false
        var cleanupFailed = false
        try {
            checkCancellation()
            require(TextRules.origin(origin) == origin)
            require(UUID.fromString(message.fileId).toString() == message.fileId)
            require(message.fileSize >= 0)
            if (!directory.isDirectory) throw IOException()
            if (message.fileSize > (directory.usableSpace - 1024 * 1024).coerceAtLeast(0)) {
                insufficientSpace = true
                throw IOException()
            }
            temporary = File.createTempFile("filehop-download-", ".part", directory)
            val request = Request.Builder().url("$origin/api/files/${message.fileId}")
                .header("Authorization", "Bearer $token").header("Accept-Encoding", "identity").build()
            val requestCall = client.newCall(request)
            synchronized(lock) { checkCancellation(); call = requestCall }
            requestCall.execute().use { response ->
                if (response.code == 401) unauthorized = true
                if (response.code != 200) throw IOException()
                val body = response.body ?: throw IOException()
                if (body.contentLength() >= 0 && body.contentLength() != message.fileSize) throw IOException()
                FileOutputStream(temporary).use { output ->
                    body.byteStream().use { input ->
                        copyExactly(input, output, DownloadStage.Downloading)
                    }
                }
            }
            synchronized(lock) { call = null }
            checkCancellation()
            progress(DownloadStage.Saving, 0)
            val outputDescriptor = resolver.openFileDescriptor(target, "wt", signal) ?: throw IOException()
            synchronized(lock) { descriptor = outputDescriptor }
            // AutoCloseOutputStream owns the descriptor, including exceptional writes and close failures.
            ParcelFileDescriptor.AutoCloseOutputStream(outputDescriptor).use { output ->
                checkCancellation()
                FileInputStream(temporary).use { input -> copyExactly(input, output, DownloadStage.Saving) }
                checkCancellation()
                output.flush()
            }
            synchronized(lock) {
                checkCancellation()
                saved = true
                descriptor = null
            }
        } catch (_: Exception) {
            // A partial system document is never success. Its name/path are not logged or retained.
        } finally {
            synchronized(lock) { call = null }
            runCatching { descriptor?.close() }
            synchronized(lock) { descriptor = null }
            if (!saved) removeDownloadTarget(resolver, target)
            temporary?.let { cleanupFailed = !removeDownloadTemporary(it) }
        }
        DownloadResult(saved, cancelled, unauthorized, cleanupFailed, insufficientSpace)
    }

    private fun copyExactly(input: java.io.InputStream, output: java.io.OutputStream, stage: DownloadStage) {
        val buffer = ByteArray(64 * 1024)
        var copied = 0L
        var lastProgress = 0L
        progress(stage, 0)
        while (true) {
            checkCancellation()
            // Read at most one byte beyond the advertised size; never grow the private file past it.
            val limit = if (copied == message.fileSize) 1 else minOf(buffer.size.toLong(), message.fileSize - copied).toInt()
            val count = input.read(buffer, 0, limit)
            checkCancellation()
            if (count == -1) break
            if (count == 0) continue
            if (count.toLong() > message.fileSize - copied) throw IOException()
            output.write(buffer, 0, count)
            copied += count
            val now = System.nanoTime()
            if (now - lastProgress >= 100_000_000L || copied == message.fileSize) {
                progress(stage, copied)
                lastProgress = now
            }
        }
        if (copied != message.fileSize) throw IOException()
        checkCancellation()
    }

    companion object {
        private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build()
    }
}

internal fun removeDownloadTarget(resolver: ContentResolver, target: Uri) {
    // SAF deletion is best effort, not a promise of provider-wide atomic save or rollback.
    runCatching { DocumentsContract.deleteDocument(resolver, target) }
}

internal fun removeDownloadTemporary(file: File): Boolean = runCatching { !file.exists() || file.delete() }.getOrDefault(false)

internal fun cleanDownloadDirectory(directory: File): Boolean = synchronized(downloadDirectoryLock) {
    runCatching {
        if (!directory.isDirectory && !directory.mkdirs()) return@runCatching false
        val files = directory.listFiles() ?: return@runCatching false
        files.fold(true) { clean, file ->
            val removed = file.isFile && removeDownloadTemporary(file)
            clean && removed
        }
    }.getOrDefault(false)
}
