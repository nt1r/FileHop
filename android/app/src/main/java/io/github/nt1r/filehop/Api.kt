package io.github.nt1r.filehop

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiFailure(val status: Int = 0, val code: String = "network", val retrySeconds: Long = 0) : IOException()
data class Message(val id: Long, val sendId: String, val kind: String, val text: String,
    val label: String, val time: String, val fileName: String, val fileState: String, val stateVersion: Long)
data class Page(val messages: List<Message>, val before: Long?, val hasOlder: Boolean,
    val after: Long?, val hasMore: Boolean, val syncCursor: Long?)
data class Attempt(val id: String, val text: String, val label: String)

class Api(private val origin: String) {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS).build()
    private suspend fun request(method: String, path: String, token: String? = null, data: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        require(TextRules.origin(origin) == origin && path.startsWith("/api/") && !path.contains(".."))
        val builder = Request.Builder().url(origin + path).header("Accept", "application/json")
        if (token != null) builder.header("Authorization", "Bearer $token")
        builder.method(method, data?.toString()?.toRequestBody("application/json".toMediaType()))
        val transport = if (path == "/api/native/session" && method == "POST")
            client.newBuilder().callTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build() else client
        try {
            transport.newCall(builder.build()).execute().use { response ->
                val source = response.body?.source() ?: throw ApiFailure()
                // A bounded page may contain JSON-escaped control characters in 50 maximum-size texts.
                if (source.request(32L * 1024 * 1024 + 1)) throw ApiFailure()
                val json = runCatching { JSONObject(source.readUtf8()) }.getOrElse { throw ApiFailure(response.code) }
                if (!response.isSuccessful) throw ApiFailure(response.code, json.optString("code"),
                    response.header("Retry-After")?.toLongOrNull()?.coerceAtLeast(0) ?: 0)
                json
            }
        } catch (e: ApiFailure) { throw e }
        catch (_: IOException) { throw ApiFailure() }
    }
    private fun session(json: JSONObject, token: String, startedAt: Long): Session {
        require(token.length == 64 && token.all { it in "0123456789abcdefABCDEF" })
        val remaining = json.getLong("expires_at") - json.getLong("server_time")
        require(remaining in 1..43_200)
        // Use request start, not response arrival, so network delay cannot extend known expiry.
        return Session(token, startedAt + remaining * 1000)
    }
    suspend fun login(username: String, password: String): Session {
        val startedAt = System.currentTimeMillis()
        val json = request("POST", "/api/native/session", data = JSONObject().put("username", username).put("password", password))
        return session(json, json.getString("token"), startedAt)
    }
    suspend fun check(token: String): Session {
        val startedAt = System.currentTimeMillis()
        return session(request("GET", "/api/native/session", token), token, startedAt)
    }
    suspend fun logout(token: String) { request("DELETE", "/api/native/session", token) }
    private fun message(json: JSONObject) = Message(json.getString("id").toLong(), json.getString("send_id"),
        json.getString("kind"), json.optString("text"), json.getString("source_label"), json.getString("created_at"),
        json.optString("file_name"), json.optString("file_state"), json.optString("state_version", "0").toLong())
    suspend fun page(token: String, before: Long? = null, after: Long? = null): Page {
        val query = before?.let { "?before=$it" } ?: after?.let { "?after=$it" } ?: ""
        val json = request("GET", "/api/messages$query", token)
        val rows = json.getJSONArray("messages")
        fun cursor(name: String): Long? = if (json.isNull(name)) null else json.getString(name).toLong()
        return Page((0 until rows.length()).map { message(rows.getJSONObject(it)) }, cursor("before"),
            json.optBoolean("has_older"), cursor("after"), json.optBoolean("has_more"), cursor("sync_cursor"))
    }
    suspend fun send(token: String, attempt: Attempt): Message = message(request("POST", "/api/messages", token,
        JSONObject().put("send_id", attempt.id).put("text", attempt.text).put("source_label", attempt.label)))
    suspend fun result(token: String, attempt: Attempt): Message = message(request("GET", "/api/sends/${attempt.id}", token))
}
