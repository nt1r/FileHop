package top.hammerbilly.filehop

import android.app.Application
import android.os.SystemClock
import android.net.Uri
import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.random.Random

enum class Phase { Configure, Checking, Login, Ready }
data class Screen(
    val phase: Phase = Phase.Checking,
    val origin: String = "",
    val label: String = "",
    val messages: List<Message> = emptyList(),
    val draft: String = "",
    val pending: Attempt? = null,
    val sending: Boolean = false,
    val reading: Boolean = false,
    val loggingIn: Boolean = false,
    val hasOlder: Boolean = false,
    @StringRes val noticeRes: Int? = null,
)

// ViewModel survives rotation, but deliberately has no SavedStateHandle or message database.
class HopViewModel(application: Application) : AndroidViewModel(application) {
    private val store = SessionStore(application)
    var screen by mutableStateOf(Screen())
        private set
    private var api: Api? = null
    private var session: Session? = null
    private var generation = 0L
    private var foreground = false
    private var poll: Job? = null
    private var expiry: Job? = null
    private var cursor: Long? = null
    private var before: Long? = null
    private var nextRead = 0L
    private var retryUntil = 0L
    private var backoff = 10L
    val upload = UploadController(application, viewModelScope,
        expired = { invalidate(false, R.string.notice_session_invalid) },
        received = { merge(listOf(it)) })
    private var fileStatusRefreshPending = false
    val downloads = FileDownloads(application, viewModelScope) {
        invalidate(false, R.string.notice_session_invalid)
    }

    fun chooseUpload(): Boolean {
        if (screen.phase != Phase.Ready || downloads.screen.pickerOpen) return false
        if ((session?.localExpiry ?: 0) <= System.currentTimeMillis()) {
            invalidate(false, R.string.notice_session_expired)
            return false
        }
        val chosen = upload.beginPicker(screen.label)
        transferForeground()
        return chosen
    }
    fun uploadSelection(uris: List<Uri>) {
        if ((session?.localExpiry ?: 0) <= System.currentTimeMillis() && screen.phase == Phase.Ready)
            invalidate(false, R.string.notice_session_expired)
        upload.pickerResult(uris)
        transferForeground()
    }
    fun uploadPickerFailed() {
        upload.pickerFailed()
        transferForeground()
    }
    fun chooseDownload(message: Message): Boolean {
        val current = session ?: return false
        if (current.localExpiry <= System.currentTimeMillis()) {
            invalidate(false, R.string.notice_session_expired)
            return false
        }
        if (screen.phase != Phase.Ready || upload.screen.pickerOpen) return false
        val chosen = downloads.choose(message, screen.origin, current.token)
        transferForeground()
        return chosen
    }
    fun downloadTarget(target: Uri?, launchFailed: Boolean = false) {
        if ((session?.localExpiry ?: 0) <= System.currentTimeMillis() && screen.phase == Phase.Ready)
            invalidate(false, R.string.notice_session_expired)
        downloads.pickerReturned(target, launchFailed)
        transferForeground()
    }
    private fun transferForeground() {
        val ready = foreground && screen.phase == Phase.Ready && !upload.screen.pickerOpen && !downloads.screen.pickerOpen
        // A picker can leave the activity STARTED. No lane starts a new file until it returns.
        upload.foreground(ready)
        downloads.foreground(ready)
    }

    init {
        val origin = store.origin
        screen = screen.copy(origin = origin ?: "", label = store.label,
            phase = if (origin == null) Phase.Configure else Phase.Checking)
        if (origin != null) {
            if (TextRules.origin(origin) != origin) {
                screen = screen.copy(phase = Phase.Login, noticeRes = R.string.notice_server_config_invalid)
            } else {
                api = Api(origin)
                restore()
            }
        }
    }
    fun configure(origin: String) {
        if (screen.phase != Phase.Configure) return
        val valid = TextRules.origin(origin)
        if (valid == null) { feedback(R.string.notice_server_address_invalid); return }
        runCatching { store.configure(valid) }.onFailure { feedback(R.string.notice_server_address_save_failed); return }
        api = Api(valid)
        screen = screen.copy(origin = valid, phase = Phase.Login, noticeRes = null)
    }
    fun changeServer(origin: String) {
        val valid = TextRules.origin(origin)
        if (valid == null) { feedback(R.string.notice_server_address_invalid); return }
        if (valid == screen.origin && api != null) return
        if (screen.sending) { feedback(R.string.notice_finish_send_before_server_change); return }
        if (upload.screen.blocksServerChange) { feedback(R.string.upload_finish_before_server_change); return }
        if (downloads.screen.busy) { feedback(R.string.notice_finish_download_before_server_change); return }
        // Switching is local and must work even when the previous server is offline.
        // In-flight requests keep their captured Api; generation rejects late responses.
        val cleared = invalidate(true, null)
        api = null
        if (!cleared) return
        try { store.configure(valid) } catch (_: Exception) {
            feedback(R.string.notice_server_change_failed)
            return
        }
        api = Api(valid)
        screen = screen.copy(origin = valid, phase = Phase.Login, noticeRes = R.string.notice_server_changed)
    }
    fun feedback(@StringRes message: Int) { screen = screen.copy(noticeRes = message) }
    fun draft(text: String) { if (screen.pending == null) screen = screen.copy(draft = text) }
    fun label(value: String) {
        val normalized = TextRules.label(value)
        if (normalized == null) { feedback(R.string.notice_source_label_invalid); return }
        runCatching { store.label = normalized }.onFailure { feedback(R.string.notice_source_label_save_failed); return }
        screen = screen.copy(label = normalized, noticeRes = R.string.notice_source_label_saved)
    }
    private fun clearStored(): Boolean = runCatching { store.clear() }.isSuccess
    private fun invalidate(explicit: Boolean, @StringRes notice: Int?): Boolean {
        generation++
        upload.invalidate(explicit)
        downloads.invalidate()
        fileStatusRefreshPending = false
        poll?.cancel(); expiry?.cancel()
        session = null; cursor = null; before = null
        nextRead = 0; retryUntil = 0; backoff = 10
        val cleared = clearStored()
        screen = screen.copy(phase = Phase.Login, messages = emptyList(), reading = false,
            hasOlder = false, loggingIn = false, sending = false,
            draft = if (explicit) "" else screen.draft,
            pending = if (explicit) null else screen.pending,
            noticeRes = if (cleared) notice else R.string.notice_credentials_clear_failed)
        return cleared
    }
    fun restore() {
        if (screen.phase != Phase.Checking || screen.loggingIn) return
        val stored = try { session ?: store.load() } catch (_: Exception) {
            invalidate(false, R.string.notice_credentials_unavailable); return
        }
        if (stored == null || stored.localExpiry <= System.currentTimeMillis()) {
            invalidate(false, if (stored == null) null else R.string.notice_session_expired); return
        }
        val client = api ?: return
        session = stored
        val epoch = generation
        screen = screen.copy(loggingIn = true, noticeRes = null)
        viewModelScope.launch {
            try {
                val checked = client.check(stored.token)
                if (generation == epoch) accept(checked)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (generation == epoch) {
                    if (e is ApiFailure && e.code == "session_invalid") invalidate(false, R.string.notice_login_required)
                    else screen = screen.copy(loggingIn = false, noticeRes = R.string.notice_session_check_failed)
                }
            }
        }
    }
    fun login(username: String, password: String) {
        if (screen.phase != Phase.Login || screen.loggingIn || api == null) return
        val client = api ?: return
        val epoch = ++generation
        screen = screen.copy(loggingIn = true, noticeRes = null)
        viewModelScope.launch {
            try {
                val authenticated = client.login(username, password)
                if (generation == epoch) accept(authenticated)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (generation == epoch) screen = screen.copy(loggingIn = false, noticeRes = when {
                    e is ApiFailure && e.code == "invalid_credentials" -> R.string.notice_credentials_invalid
                    e is ApiFailure && e.status == 429 -> R.string.notice_login_rate_limited
                    else -> R.string.notice_login_failed
                })
            }
        }
    }
    private fun accept(value: Session) {
        if (value.localExpiry <= System.currentTimeMillis()) {
            invalidate(false, R.string.notice_session_expired); return
        }
        try { store.save(value) } catch (_: Exception) {
            invalidate(false, R.string.notice_credentials_save_failed); return
        }
        session = value
        upload.authenticated(screen.origin, value.token, value.localExpiry)
        cursor = null; before = null; nextRead = 0; retryUntil = 0; backoff = 10
        screen = screen.copy(phase = Phase.Ready, loggingIn = false, messages = emptyList(),
            noticeRes = if (screen.pending == null) null else R.string.notice_previous_send_unconfirmed)
        expiry?.cancel()
        expiry = viewModelScope.launch {
            delay((value.localExpiry - System.currentTimeMillis()).coerceAtLeast(0))
            invalidate(false, R.string.notice_session_expired)
        }
        transferForeground()
        if (foreground) { refresh(); startPolling() }
    }
    fun logout() {
        val client = api
        val previous = session
        invalidate(true, R.string.notice_logout_local)
        val epoch = generation
        if (previous != null) viewModelScope.launch {
            try { client?.logout(previous.token) }
            catch (e: Exception) {
                if (e is CancellationException) throw e
                if (generation == epoch && !(e is ApiFailure && e.code == "session_invalid"))
                    feedback(R.string.notice_logout_unconfirmed)
            }
        }
    }
    fun foreground(visible: Boolean) {
        foreground = visible
        if (visible && screen.phase == Phase.Ready && (session?.localExpiry ?: 0) <= System.currentTimeMillis())
            invalidate(false, R.string.notice_session_expired)
        transferForeground()
        if (!visible) { poll?.cancel(); return }
        if (screen.phase == Phase.Ready) { refresh(); startPolling() }
    }
    private fun startPolling() {
        poll?.cancel()
        poll = viewModelScope.launch {
            while (foreground && screen.phase == Phase.Ready) {
                delay(1000)
                if (SystemClock.elapsedRealtime() >= nextRead) refresh(manual = false)
            }
        }
    }
    private fun failure(e: Exception, epoch: Long, sending: Boolean = false) {
        if (e is CancellationException) throw e
        if (generation != epoch) return
        if (e is ApiFailure && e.status == 401 && e.code == "session_invalid") {
            invalidate(false, R.string.notice_session_invalid); return
        }
        if (e is ApiFailure && e.retrySeconds > 0) retryUntil = maxOf(retryUntil,
            SystemClock.elapsedRealtime() + e.retrySeconds.coerceAtMost(86_400) * 1000)
        feedback(if (sending) R.string.notice_send_unconfirmed else R.string.notice_read_failed)
    }
    private fun merge(rows: List<Message>) {
        val messages = FileMessageRules.merge(screen.messages, rows)
        val pending = screen.pending
        val confirmed = pending != null && rows.any {
            it.kind == "TEXT" && it.sendId == pending.id && it.text == pending.text && it.label == pending.label
        }
        screen = screen.copy(messages = messages,
            pending = if (confirmed) null else pending,
            sending = if (confirmed) false else screen.sending,
            draft = if (confirmed && screen.draft == pending?.text) "" else screen.draft,
            noticeRes = if (confirmed) R.string.notice_send_success else screen.noticeRes)
    }
    fun refresh(manual: Boolean = true, older: Boolean = false) {
        val client = api ?: return
        val token = session?.token ?: return
        val time = SystemClock.elapsedRealtime()
        if (manual && !older && screen.phase == Phase.Ready) fileStatusRefreshPending = true
        if (!foreground || screen.phase != Phase.Ready || screen.reading || time < retryUntil ||
            (!manual && time < nextRead) || (older && (!screen.hasOlder || before == null))) return
        val epoch = generation
        screen = screen.copy(reading = true)
        viewModelScope.launch {
            try {
                if (older) {
                    val page = client.page(token, before = before)
                    if (epoch != generation) return@launch
                    merge(page.messages); before = page.before
                    screen = screen.copy(hasOlder = page.hasOlder)
                } else if (cursor == null) {
                    val page = client.page(token)
                    if (epoch != generation) return@launch
                    require(page.syncCursor != null)
                    merge(page.messages); cursor = page.syncCursor; before = page.before
                    screen = screen.copy(hasOlder = page.hasOlder)
                } else {
                    if (manual) {
                        val latest = client.page(token)
                        if (epoch != generation) return@launch
                        merge(latest.messages) // Never advance the incremental cursor from a recent snapshot.
                    }
                    do {
                        val start = cursor
                        val page = client.page(token, after = start)
                        if (epoch != generation) return@launch
                        if (page.messages.isNotEmpty()) require(page.after != null && page.after > requireNotNull(start))
                        else require(!page.hasMore)
                        merge(page.messages)
                        if (page.messages.isNotEmpty()) cursor = page.after
                    } while (page.hasMore && foreground)
                }
                if (fileStatusRefreshPending && foreground) {
                    fileStatusRefreshPending = false
                    val fileIds = screen.messages.filter { it.kind == "FILE" }.map { it.fileId }.distinct()
                    for (batch in fileIds.chunked(100)) {
                        val statuses = client.fileStatuses(token, batch)
                        if (epoch != generation) return@launch
                        screen = screen.copy(messages = FileMessageRules.correct(screen.messages, statuses))
                    }
                }
                backoff = 10; nextRead = SystemClock.elapsedRealtime() + 10_000
            } catch (e: Exception) {
                failure(e, epoch)
                if (epoch == generation) {
                    nextRead = maxOf(retryUntil, SystemClock.elapsedRealtime() + backoff * 1000 + Random.nextLong(500))
                    backoff = (backoff * 2).coerceAtMost(60)
                }
            } finally {
                if (epoch == generation) screen = screen.copy(reading = false)
            }
        }
    }
    fun send() {
        if (screen.phase != Phase.Ready || screen.pending != null || !TextRules.validText(screen.draft)) return
        if (SystemClock.elapsedRealtime() < retryUntil) {
            feedback(R.string.notice_send_rate_limited); return
        }
        val attempt = Attempt(UUID.randomUUID().toString(), screen.draft, screen.label)
        screen = screen.copy(pending = attempt)
        resolve(query = false, first = true)
    }
    fun resolve(query: Boolean, first: Boolean = false) {
        val client = api ?: return
        val attempt = screen.pending ?: return
        val token = session?.token ?: return
        if (screen.phase != Phase.Ready || screen.sending || SystemClock.elapsedRealtime() < retryUntil) return
        val epoch = generation
        screen = screen.copy(sending = true, noticeRes = if (query) R.string.notice_query_in_progress else R.string.notice_send_in_progress)
        viewModelScope.launch {
            try {
                val message = if (query) client.result(token, attempt) else client.send(token, attempt)
                if (epoch == generation) {
                    require(message.sendId == attempt.id && message.text == attempt.text && message.label == attempt.label)
                    merge(listOf(message))
                }
            } catch (e: Exception) {
                failure(e, epoch, sending = true)
                if (epoch == generation && screen.pending == attempt && first && e is ApiFailure &&
                    e.status in listOf(400, 413, 422) && e.code in listOf("invalid_json", "body_too_large", "text_too_large", "empty_text", "invalid_source_label", "invalid_send_id")) {
                    screen = screen.copy(pending = null, noticeRes = R.string.notice_send_rejected)
                }
            } finally {
                if (epoch == generation && screen.pending == attempt) screen = screen.copy(sending = false)
            }
        }
    }
    override fun onCleared() {
        upload.invalidate(true)
        downloads.invalidate()
        super.onCleared()
    }
    fun abandon() {
        if (screen.sending) return
        screen = screen.copy(pending = null, sending = false, noticeRes = R.string.notice_send_abandoned)
    }
}
