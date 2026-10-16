package top.hammerbilly.filehop

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import android.os.CancellationSignal
import android.provider.OpenableColumns
import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID

enum class UploadPhase { Idle, Limits, Staging, Preparing, Transferring, Confirming, Querying, Unconfirmed, Success, Failed }
data class UploadWaiting(val id: Long, val name: String = "", val size: Long? = null)
data class UploadResult(val name: String, val size: Long?, val success: Boolean, @StringRes val noticeRes: Int?)
data class UploadScreen(
    val phase: UploadPhase = UploadPhase.Idle,
    val name: String = "",
    val size: Long = 0,
    val sent: Long = 0,
    val sizeKnown: Boolean = false,
    val waiting: List<UploadWaiting> = emptyList(),
    val completed: List<UploadResult> = emptyList(),
    val pickerOpen: Boolean = false,
    val settling: Boolean = true,
    val cleanupBlocked: Boolean = false,
    @StringRes val noticeRes: Int? = null,
) {
    val active: Boolean get() = phase in setOf(UploadPhase.Limits, UploadPhase.Staging,
        UploadPhase.Preparing, UploadPhase.Transferring, UploadPhase.Confirming, UploadPhase.Querying)
    val blocksServerChange: Boolean get() = pickerOpen || waiting.isNotEmpty() || active || settling || phase == UploadPhase.Unconfirmed
    val canChoose: Boolean get() = !pickerOpen && !cleanupBlocked && (!settling || active)
}

// Owned by the activity ViewModel, never by a composable or a persistent task store.
class UploadController internal constructor(context: Context, private val scope: CoroutineScope,
    private val expired: () -> Unit, private val received: (Message) -> Unit) {
    private val resolver = context.applicationContext.contentResolver
    private val directory = File(context.cacheDir, "upload-staging")
    var screen by mutableStateOf(UploadScreen())
        private set
    private var credentials: Pair<String, String>? = null
    private var localExpiry = 0L
    private var pickerLabel = ""
    private var visible = false
    private var epoch = 0L
    private var batch = 0L
    private var pickerEpoch = 0L
    private var nextItemId = 0L
    private data class WaitingUpload(val id: Long, val uri: Uri, val label: String, val described: Boolean = false)
    private val waiting = mutableListOf<WaitingUpload>()
    private var descriptions: Job? = null
    private var descriptionSignal: CancellationSignal? = null
    private var nextStart: Job? = null
    private var identity: UploadIdentity? = null
    private var operation: UploadOperation? = null
    private var retryUntil = 0L

    init { retryCleanup() }

    internal fun authenticated(origin: String, token: String, expiresAt: Long) {
        credentials = origin to token
        localExpiry = expiresAt
    }
    fun foreground(value: Boolean) {
        visible = value
        if (value) startNext() else nextStart?.cancel()
    }
    fun beginPicker(sourceLabel: String): Boolean {
        if (credentials == null || !visible || !screen.canChoose) return false
        if (SystemClock.elapsedRealtime() < retryUntil) {
            screen = screen.copy(noticeRes = R.string.upload_request_wait); return false
        }
        pickerLabel = sourceLabel
        pickerEpoch = batch
        screen = screen.copy(pickerOpen = true)
        return true
    }
    fun pickerResult(uris: List<Uri>) {
        if (!screen.pickerOpen) return // A process restart must not resurrect a selection.
        screen = screen.copy(pickerOpen = false)
        if (pickerEpoch != batch || credentials == null) return
        val additions = uris.map { WaitingUpload(++nextItemId, it, pickerLabel) }
        pickerLabel = ""
        waiting.addAll(additions)
        screen = screen.copy(waiting = screen.waiting + additions.map { UploadWaiting(it.id) })
        describeWaiting()
        startNext()
    }
    fun pickerFailed() {
        pickerResult(emptyList())
        screen = screen.copy(noticeRes = R.string.upload_picker_failed)
    }
    fun removeWaiting(id: Long) {
        waiting.removeAll { it.id == id }
        screen = screen.copy(waiting = screen.waiting.filterNot { it.id == id })
        stopDescriptions()
        describeWaiting()
        startNext()
    }
    // Metadata only: waiting items never open file bodies, create snapshots, or reserve server space.
    private fun describeWaiting() {
        if (descriptions?.isActive == true) return
        val version = batch
        descriptions = scope.launch {
            while (true) {
                val item = waiting.firstOrNull { !it.described } ?: break
                val id = item.id
                val signal = CancellationSignal()
                descriptionSignal = signal
                val details = withContext(Dispatchers.IO) {
                    runCatching {
                        resolver.query(item.uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null, signal)?.use {
                            if (it.moveToFirst()) UploadWaiting(id, it.getString(0).orEmpty(),
                                if (it.isNull(1)) null else it.getLong(1).takeIf { size -> size >= 0 }) else null
                        }
                    }.getOrNull()
                }
                if (descriptionSignal === signal) descriptionSignal = null
                if (version != batch) return@launch
                val index = waiting.indexOfFirst { it.id == id }
                if (index >= 0) {
                    waiting[index] = item.copy(described = true)
                    if (details != null) screen = screen.copy(waiting = screen.waiting.map { if (it.id == id) details else it })
                    startNext()
                }
            }
        }
    }
    private fun stopDescriptions() {
        descriptions?.cancel()
        descriptions = null
        val signal = descriptionSignal
        descriptionSignal = null
        if (signal != null) scope.launch(Dispatchers.IO + NonCancellable) { runCatching { signal.cancel() } }
    }
    private fun clean(): Boolean = try {
        if (!directory.exists()) true else directory.listFiles()?.all { it.isFile && it.delete() } == true
    } catch (_: Exception) { false }
    fun retryCleanup() {
        if (operation != null || !screen.settling && !screen.cleanupBlocked) return
        screen = screen.copy(settling = true)
        val op = UploadOperation()
        operation = op
        scope.launch {
            val cleaned = withContext(Dispatchers.IO + NonCancellable) { clean() }
            if (operation === op) {
                operation = null
                screen = screen.copy(settling = false, cleanupBlocked = !cleaned)
                startNext()
            }
        }
    }
    private class LocalFailure(@StringRes val resource: Int) : IOException()
    private data class UploadSnapshot(val file: File, val name: String, val mime: String, val size: Long)
    private fun snapshot(uri: Uri, op: UploadOperation, limits: UploadLimits): UploadSnapshot {
        op.checkActive()
        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        } ?: throw LocalFailure(R.string.upload_source_failed)
        val mime = resolver.getType(uri) ?: ""
        if (name.isEmpty() || name.toByteArray(Charsets.UTF_8).size > 1024 || '\u0000' in name ||
            mime.toByteArray(Charsets.UTF_8).size > 255) throw LocalFailure(R.string.upload_metadata_invalid)
        if (!directory.isDirectory && !directory.mkdirs()) throw LocalFailure(R.string.upload_space_failed)
        val file = File(directory, "snapshot")
        val created = try { file.createNewFile() } catch (_: IOException) { throw LocalFailure(R.string.upload_space_failed) }
        if (!created) throw LocalFailure(R.string.upload_cleanup_failed)
        var count = 0L
        resolver.openInputStream(uri)?.use { input ->
            op.attach(input)
            try {
                val output = try { file.outputStream() } catch (_: IOException) { throw LocalFailure(R.string.upload_space_failed) }
                try {
                    output.use {
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            op.checkActive()
                            // Read at most the remaining allowance plus one byte, even for unknown provider sizes.
                            val length = if (limits.maximum - count < buffer.size) (limits.maximum - count).toInt() + 1 else buffer.size
                            val read = try { input.read(buffer, 0, length) }
                            catch (_: IOException) { throw LocalFailure(R.string.upload_source_failed) }
                            if (read < 0) break
                            if (read == 0) continue
                            if (read.toLong() > limits.maximum - count) throw LocalFailure(R.string.upload_too_large)
                            if (directory.usableSpace < read.toLong() + 1024 * 1024) throw LocalFailure(R.string.upload_space_failed)
                            output.write(buffer, 0, read)
                            count += read
                        }
                    }
                } catch (e: LocalFailure) { throw e }
                catch (_: IOException) { throw LocalFailure(R.string.upload_space_failed) }
            } finally { op.detachSource() }
        } ?: throw LocalFailure(R.string.upload_source_failed)
        op.checkActive()
        return UploadSnapshot(file, name, mime, count)
    }
    private fun startNext() {
        val item = waiting.firstOrNull() ?: return
        val auth = credentials ?: return
        if (!visible || !item.described || operation != null || identity != null || screen.cleanupBlocked) return
        if (localExpiry <= System.currentTimeMillis()) { expired(); return }
        val pause = retryUntil - SystemClock.elapsedRealtime()
        if (pause > 0) {
            nextStart?.cancel()
            nextStart = scope.launch { delay(pause); startNext() }
            return
        }
        val completed = if (screen.phase in setOf(UploadPhase.Success, UploadPhase.Failed))
            screen.completed + UploadResult(screen.name, screen.size.takeIf { screen.sizeKnown },
                screen.phase == UploadPhase.Success, screen.noticeRes) else screen.completed
        val details = screen.waiting.first { it.id == item.id }
        waiting.removeAt(0)
        val uri = item.uri
        val version = epoch
        val op = UploadOperation()
        operation = op
        screen = screen.copy(phase = UploadPhase.Limits, name = details.name, size = details.size ?: 0,
            sizeKnown = details.size != null, sent = 0, settling = true, noticeRes = null,
            waiting = screen.waiting.drop(1), completed = completed)
        val sourceLabel = item.label
        scope.launch {
            try {
                val api = UploadApi(auth.first, auth.second)
                val limits = withContext(Dispatchers.IO) { api.limits(op) }
                if (!current(version, op)) return@launch
                screen = screen.copy(phase = UploadPhase.Staging)
                val staged = withContext(Dispatchers.IO) { snapshot(uri, op, limits) }
                if (!current(version, op)) return@launch
                val fixed = UploadIdentity(UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                    staged.name, staged.size, staged.mime, sourceLabel)
                identity = fixed
                screen = screen.copy(phase = UploadPhase.Preparing, name = fixed.name, size = fixed.size, sizeKnown = true)
                withContext(Dispatchers.IO) { api.prepare(op, fixed) }
                if (!current(version, op)) return@launch
                screen = screen.copy(phase = UploadPhase.Transferring)
                val progress = MutableStateFlow(0L)
                val observer = scope.launch {
                    progress.collect { sent ->
                        if (current(version, op)) screen = screen.copy(sent = sent,
                            phase = if (sent == fixed.size) UploadPhase.Confirming else UploadPhase.Transferring)
                    }
                }
                var lastProgress = 0L
                val result = try {
                    withContext(Dispatchers.IO) {
                        api.upload(op, fixed, staged.file, limits) { sent ->
                            val now = SystemClock.elapsedRealtime()
                            if (now - lastProgress >= 100 || sent == fixed.size) {
                                lastProgress = now
                                progress.value = sent
                            }
                        }
                    }
                } finally { observer.cancel() }
                if (current(version, op)) success(result, fixed, auth.first)
            } catch (e: Exception) {
                if (current(version, op)) handleFailure(e)
            } finally { finish(op) }
        }
    }
    private fun current(version: Long, op: UploadOperation) = version == epoch && operation === op && !op.cancelled
    private fun success(json: JSONObject, fixed: UploadIdentity, origin: String) {
        require(json.getString("kind") == "FILE" && json.getString("send_id") == fixed.sendId &&
            json.getString("file_name") == fixed.name && json.getLong("file_size") == fixed.size &&
            json.getString("source_label") == fixed.label && json.getString("file_mime") == fixed.mime)
        val message = Api(origin).message(json)
        identity = null
        screen = screen.copy(phase = UploadPhase.Success, sent = fixed.size, noticeRes = null)
        received(message)
    }
    private fun handleFailure(e: Exception) {
        if (e is ApiFailure && e.status == 401 && e.code == "session_invalid") { expired(); return }
        if (e is ApiFailure && e.retrySeconds > 0) retryUntil = maxOf(retryUntil,
            SystemClock.elapsedRealtime() + e.retrySeconds.coerceAtMost(86_400) * 1000)
        val preparing = screen.phase == UploadPhase.Preparing
        val rejected = e is ApiFailure && e.code.isNotEmpty() && (
            preparing && (e.status in 400..499 && e.status != 409 || e.code in listOf("quota_exceeded", "disk_full")) ||
                screen.phase != UploadPhase.Querying && e.code in listOf("upload_failed", "cleanup_pending"))
        val unknown = identity != null && !rejected
        screen = screen.copy(phase = if (unknown) UploadPhase.Unconfirmed else UploadPhase.Failed,
            noticeRes = when {
                unknown -> R.string.upload_unconfirmed
                e is LocalFailure -> e.resource
                e is ApiFailure && e.code == "quota_exceeded" -> R.string.upload_quota_failed
                e is ApiFailure && e.code == "disk_full" -> R.string.upload_server_disk_failed
                e is ApiFailure && e.code == "cleanup_pending" -> R.string.upload_server_cleanup
                screen.phase == UploadPhase.Limits -> R.string.upload_limits_failed
                identity == null -> R.string.upload_source_failed
                else -> R.string.upload_rejected
            })
        if (!unknown) identity = null
    }
    private suspend fun finish(op: UploadOperation) {
        val cleaned = withContext(Dispatchers.IO + NonCancellable) { op.closeSource(); clean() }
        if (operation === op) {
            operation = null
            screen = screen.copy(settling = false, cleanupBlocked = !cleaned)
            startNext()
        }
    }
    fun query() {
        val fixed = identity ?: return
        val auth = credentials ?: return
        if (!visible || operation != null || screen.phase != UploadPhase.Unconfirmed) return
        if (SystemClock.elapsedRealtime() < retryUntil) {
            screen = screen.copy(noticeRes = R.string.upload_query_wait); return
        }
        val version = epoch
        val op = UploadOperation()
        operation = op
        screen = screen.copy(phase = UploadPhase.Querying, settling = true, noticeRes = null)
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) { UploadApi(auth.first, auth.second).result(op, fixed) }
                if (!current(version, op)) return@launch
                require(result.getString("send_id") == fixed.sendId)
                if (result.getString("state") == "success") success(result.getJSONObject("message"), fixed, auth.first)
                else {
                    require(result.getString("attempt_id") == fixed.attemptId)
                    when (result.getString("state")) {
                        "failed", "stopped", "cleaning" -> {
                            identity = null
                            screen = screen.copy(phase = UploadPhase.Failed, noticeRes =
                                if (result.getString("state") == "cleaning") R.string.upload_server_cleanup else R.string.upload_rejected)
                        }
                        else -> screen = screen.copy(phase = UploadPhase.Unconfirmed, noticeRes = R.string.upload_unconfirmed)
                    }
                }
            } catch (e: Exception) { if (current(version, op)) handleFailure(e) }
            finally { finish(op) }
        }
    }
    private fun stopLocal() {
        epoch++
        nextStart?.cancel()
        operation?.let { op ->
            op.cancel()
            scope.launch(Dispatchers.IO + NonCancellable) { op.closeSource() }
        }
    }
    fun interrupt() {
        if (!screen.active || screen.phase == UploadPhase.Querying) return
        stopLocal()
        screen = screen.copy(phase = if (identity == null) UploadPhase.Failed else UploadPhase.Unconfirmed,
            noticeRes = if (identity == null) R.string.upload_interrupted_before_send else R.string.upload_unconfirmed)
    }
    private fun clearBatch() {
        batch++
        waiting.clear()
        stopDescriptions()
        pickerLabel = ""
    }
    fun endRound() {
        stopLocal()
        clearBatch()
        identity = null
        screen = UploadScreen(pickerOpen = screen.pickerOpen, settling = operation != null,
            cleanupBlocked = screen.cleanupBlocked)
    }
    internal fun invalidate(explicit: Boolean) {
        val interrupted = screen.active || identity != null || waiting.isNotEmpty() || screen.pickerOpen
        credentials = null
        stopLocal()
        clearBatch()
        if (explicit) identity = null
        val fixed = identity
        screen = UploadScreen(phase = if (fixed == null) UploadPhase.Idle else UploadPhase.Unconfirmed,
            name = fixed?.name.orEmpty(), size = fixed?.size ?: 0, sizeKnown = fixed != null,
            pickerOpen = screen.pickerOpen, settling = operation != null, cleanupBlocked = screen.cleanupBlocked,
            noticeRes = if (interrupted && !explicit) R.string.upload_auth_interrupted else null)
        retryUntil = 0
    }
}
