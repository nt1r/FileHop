package io.github.nt1r.filehop

import android.app.Application
import android.os.SystemClock
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
    val label: String = "Android",
    val messages: List<Message> = emptyList(),
    val draft: String = "",
    val pending: Attempt? = null,
    val sending: Boolean = false,
    val reading: Boolean = false,
    val loggingIn: Boolean = false,
    val hasOlder: Boolean = false,
    val notice: String = "",
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

    init {
        val origin = store.origin
        screen = screen.copy(origin = origin ?: "", label = store.label,
            phase = if (origin == null) Phase.Configure else Phase.Checking)
        if (origin != null) {
            if (TextRules.origin(origin) != origin) {
                screen = screen.copy(phase = Phase.Login, notice = "服务器配置无效，请清除应用数据后重新配置")
            } else {
                api = Api(origin)
                restore()
            }
        }
    }
    fun configure(origin: String) {
        val valid = TextRules.origin(origin)
        if (valid == null) { feedback("请输入 HTTPS 域名根地址，不含路径、账号或查询参数"); return }
        runCatching { store.configure(valid) }.onFailure { feedback("无法保存服务器地址"); return }
        api = Api(valid)
        screen = screen.copy(origin = valid, phase = Phase.Login, notice = "")
    }
    fun feedback(text: String) { screen = screen.copy(notice = text) }
    fun draft(text: String) { if (screen.pending == null) screen = screen.copy(draft = text) }
    fun label(value: String) {
        val normalized = TextRules.label(value)
        if (normalized == null) { feedback("来源标签须为 1–64 个字符"); return }
        runCatching { store.label = normalized }.onFailure { feedback("无法保存来源标签"); return }
        screen = screen.copy(label = normalized, notice = "来源标签已保存")
    }
    private fun clearStored(): Boolean = runCatching { store.clear() }.isSuccess
    private fun invalidate(explicit: Boolean, notice: String) {
        generation++
        poll?.cancel(); expiry?.cancel()
        session = null; cursor = null; before = null
        nextRead = 0; retryUntil = 0; backoff = 10
        val cleared = clearStored()
        screen = screen.copy(phase = Phase.Login, messages = emptyList(), reading = false,
            hasOlder = false, loggingIn = false, sending = false,
            draft = if (explicit) "" else screen.draft,
            pending = if (explicit) null else screen.pending,
            notice = if (cleared) notice else "无法清除本机凭证，请清除应用数据后重新登录")
    }
    fun restore() {
        if (screen.phase != Phase.Checking || screen.loggingIn) return
        val stored = try { session ?: store.load() } catch (_: Exception) {
            invalidate(false, "安全凭证不可用，请重新登录"); return
        }
        if (stored == null || stored.localExpiry <= System.currentTimeMillis()) {
            invalidate(false, if (stored == null) "" else "登录已到期，请重新登录"); return
        }
        session = stored
        val epoch = generation
        screen = screen.copy(loggingIn = true, notice = "")
        viewModelScope.launch {
            try {
                val checked = requireNotNull(api).check(stored.token)
                if (generation == epoch) accept(checked)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (generation == epoch) {
                    if (e is ApiFailure && e.code == "session_invalid") invalidate(false, "请重新登录")
                    else screen = screen.copy(loggingIn = false, notice = "无法检查登录状态，请重试")
                }
            }
        }
    }
    fun login(username: String, password: String) {
        if (screen.phase != Phase.Login || screen.loggingIn || api == null) return
        val epoch = ++generation
        screen = screen.copy(loggingIn = true, notice = "")
        viewModelScope.launch {
            try {
                val authenticated = requireNotNull(api).login(username, password)
                if (generation == epoch) accept(authenticated)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (generation == epoch) screen = screen.copy(loggingIn = false, notice = when {
                    e is ApiFailure && e.code == "invalid_credentials" -> "用户名或密码错误"
                    e is ApiFailure && e.status == 429 -> "登录请求过多，请稍后重试"
                    else -> "登录未完成，请检查网络后重试"
                })
            }
        }
    }
    private fun accept(value: Session) {
        if (value.localExpiry <= System.currentTimeMillis()) {
            invalidate(false, "登录已到期，请重新登录"); return
        }
        try { store.save(value) } catch (_: Exception) {
            invalidate(false, "无法安全保存凭证，请重新登录"); return
        }
        session = value
        cursor = null; before = null; nextRead = 0; retryUntil = 0; backoff = 10
        screen = screen.copy(phase = Phase.Ready, loggingIn = false, messages = emptyList(),
            notice = if (screen.pending == null) "" else "上次发送结果未确认，请手动查询或同次重试")
        expiry?.cancel()
        expiry = viewModelScope.launch {
            delay((value.localExpiry - System.currentTimeMillis()).coerceAtLeast(0))
            invalidate(false, "登录已到期，请重新登录")
        }
        if (foreground) { refresh(); startPolling() }
    }
    fun logout() {
        val previous = session
        invalidate(true, "已退出本机登录")
        val epoch = generation
        if (previous != null) viewModelScope.launch {
            try { api?.logout(previous.token) }
            catch (e: Exception) {
                if (e is CancellationException) throw e
                if (generation == epoch && !(e is ApiFailure && e.code == "session_invalid"))
                    feedback("本机已退出，但服务器撤销未确认；原凭证到期前可能仍有效")
            }
        }
    }
    fun foreground(visible: Boolean) {
        foreground = visible
        if (!visible) { poll?.cancel(); return }
        if (screen.phase == Phase.Ready) {
            if ((session?.localExpiry ?: 0) <= System.currentTimeMillis()) invalidate(false, "登录已到期，请重新登录")
            else { refresh(); startPolling() }
        }
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
            invalidate(false, "登录已失效，请重新登录"); return
        }
        if (e is ApiFailure && e.retrySeconds > 0) retryUntil = maxOf(retryUntil,
            SystemClock.elapsedRealtime() + e.retrySeconds.coerceAtMost(86_400) * 1000)
        feedback(if (sending) "发送结果未确认，可查询、同次重试或放弃确认" else "读取失败，保留已有内容；稍后重试")
    }
    private fun merge(rows: List<Message>) {
        val all = screen.messages.associateBy { it.id }.toMutableMap()
        rows.forEach { message ->
            val old = all[message.id]
            if (old == null || message.stateVersion >= old.stateVersion) all[message.id] = message
        }
        val pending = screen.pending
        val confirmed = pending != null && rows.any {
            it.kind == "TEXT" && it.sendId == pending.id && it.text == pending.text && it.label == pending.label
        }
        screen = screen.copy(messages = all.values.sortedBy { it.id },
            pending = if (confirmed) null else pending,
            sending = if (confirmed) false else screen.sending,
            draft = if (confirmed && screen.draft == pending?.text) "" else screen.draft,
            notice = if (confirmed) "已发送" else screen.notice)
    }
    fun refresh(manual: Boolean = true, older: Boolean = false) {
        val token = session?.token ?: return
        val time = SystemClock.elapsedRealtime()
        if (!foreground || screen.phase != Phase.Ready || screen.reading || time < retryUntil ||
            (!manual && time < nextRead) || (older && (!screen.hasOlder || before == null))) return
        val epoch = generation
        screen = screen.copy(reading = true)
        viewModelScope.launch {
            try {
                if (older) {
                    val page = requireNotNull(api).page(token, before = before)
                    if (epoch != generation) return@launch
                    merge(page.messages); before = page.before
                    screen = screen.copy(hasOlder = page.hasOlder)
                } else if (cursor == null) {
                    val page = requireNotNull(api).page(token)
                    if (epoch != generation) return@launch
                    require(page.syncCursor != null)
                    merge(page.messages); cursor = page.syncCursor; before = page.before
                    screen = screen.copy(hasOlder = page.hasOlder)
                } else {
                    if (manual) {
                        val latest = requireNotNull(api).page(token)
                        if (epoch != generation) return@launch
                        merge(latest.messages) // Never advance the incremental cursor from a recent snapshot.
                    }
                    do {
                        val start = cursor
                        val page = requireNotNull(api).page(token, after = start)
                        if (epoch != generation) return@launch
                        if (page.messages.isNotEmpty()) require(page.after != null && page.after > requireNotNull(start))
                        else require(!page.hasMore)
                        merge(page.messages)
                        if (page.messages.isNotEmpty()) cursor = page.after
                    } while (page.hasMore && foreground)
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
            feedback("请求过多，请稍后再发送"); return
        }
        val attempt = Attempt(UUID.randomUUID().toString(), screen.draft, screen.label)
        screen = screen.copy(pending = attempt)
        resolve(query = false, first = true)
    }
    fun resolve(query: Boolean, first: Boolean = false) {
        val attempt = screen.pending ?: return
        val token = session?.token ?: return
        if (screen.phase != Phase.Ready || screen.sending || SystemClock.elapsedRealtime() < retryUntil) return
        val epoch = generation
        screen = screen.copy(sending = true, notice = if (query) "正在查询" else "正在发送")
        viewModelScope.launch {
            try {
                val message = if (query) requireNotNull(api).result(token, attempt) else requireNotNull(api).send(token, attempt)
                if (epoch == generation) {
                    require(message.sendId == attempt.id && message.text == attempt.text && message.label == attempt.label)
                    merge(listOf(message))
                }
            } catch (e: Exception) {
                failure(e, epoch, sending = true)
                if (epoch == generation && screen.pending == attempt && first && e is ApiFailure &&
                    e.status in listOf(400, 413, 422) && e.code in listOf("invalid_json", "body_too_large", "text_too_large", "empty_text", "invalid_source_label", "invalid_send_id")) {
                    screen = screen.copy(pending = null, notice = "发送被拒绝，请检查正文和来源标签")
                }
            } finally {
                if (epoch == generation && screen.pending == attempt) screen = screen.copy(sending = false)
            }
        }
    }
    fun abandon() {
        if (screen.sending) return
        screen = screen.copy(pending = null, sending = false, notice = "原消息可能已保存；再次发送可能重复")
    }
}
