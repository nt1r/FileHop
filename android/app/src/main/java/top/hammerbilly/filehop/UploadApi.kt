package top.hammerbilly.filehop

import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

internal data class UploadLimits(val maximum: Long, val timeoutSeconds: Long)
internal data class UploadIdentity(val sendId: String, val attemptId: String, val name: String,
    val size: Long, val mime: String, val label: String)

// One operation owns its I/O until it has unwound. Cancellation never authorizes another writer.
internal class UploadOperation {
    @Volatile var cancelled = false
        private set
    private var call: Call? = null
    private var source: Closeable? = null
    @Synchronized fun attach(value: Call) {
        checkActive()
        call = value
    }
    @Synchronized fun attach(value: Closeable) {
        checkActive()
        source = value
    }
    @Synchronized fun detachSource() { source = null }
    @Synchronized fun cancel() { cancelled = true; call?.cancel() }
    // Provider close may block: callers run this off the main thread.
    fun closeSource() {
        val closing = synchronized(this) { source.also { source = null } }
        runCatching { closing?.close() }
    }
    fun checkActive() { if (cancelled) throw IOException("interrupted") }
}

internal class UploadApi(private val origin: String, private val token: String) {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS).build()

    private fun request(operation: UploadOperation, method: String, path: String,
        body: RequestBody? = null, timeout: Long? = null): JSONObject {
        require(TextRules.origin(origin) == origin)
        operation.checkActive()
        val transport = if (timeout == null) client else client.newBuilder()
            .callTimeout(0, TimeUnit.MILLISECONDS).readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS).build()
        val call = transport.newCall(Request.Builder().url(origin + path)
            .header("Authorization", "Bearer $token").header("Accept", "application/json")
            .method(method, body).build())
        // Builder timeouts use Int milliseconds; the server contract permits longer totals.
        if (timeout != null) call.timeout().timeout(timeout + 60, TimeUnit.SECONDS)
        operation.attach(call)
        call.execute().use { response ->
            operation.checkActive()
            val source = response.body?.source() ?: throw ApiFailure()
            if (source.request(128 * 1024L + 1)) throw ApiFailure()
            if (response.header("Content-Type")?.substringBefore(';')?.trim() != "application/json") throw ApiFailure()
            val json = runCatching { JSONObject(source.readUtf8()) }.getOrElse { throw ApiFailure() }
            if (!response.isSuccessful) throw ApiFailure(response.code, json.optString("code"),
                response.header("Retry-After")?.toLongOrNull()?.coerceAtLeast(0) ?: 0)
            return json
        }
    }
    fun limits(operation: UploadOperation): UploadLimits {
        val json = request(operation, "GET", "/api/transfer-limits")
        val maximum = json.getLong("max_file_size_bytes")
        val timeout = json.getLong("upload_total_timeout_seconds")
        require(maximum >= 0 && timeout in 1..4_294_907)
        return UploadLimits(maximum, timeout)
    }
    fun prepare(operation: UploadOperation, identity: UploadIdentity) {
        val bytes = JSONObject().put("send_id", identity.sendId).put("attempt_id", identity.attemptId)
            .put("name", identity.name).put("size", identity.size).put("mime", identity.mime)
            .put("source_label", identity.label).toString().toByteArray(Charsets.UTF_8)
        val body = object : RequestBody() {
            override fun contentType() = "application/json".toMediaType()
            override fun contentLength() = bytes.size.toLong()
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) { operation.checkActive(); sink.write(bytes) }
        }
        val result = request(operation, "POST", "/api/file-sends", body)
        require(result.getString("state") == "prepared" && result.getString("send_id") == identity.sendId &&
            result.getString("attempt_id") == identity.attemptId)
    }
    fun upload(operation: UploadOperation, identity: UploadIdentity, snapshot: File,
        limits: UploadLimits, progress: (Long) -> Unit): JSONObject {
        val body = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = identity.size
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                snapshot.inputStream().use { input ->
                    operation.attach(input)
                    try {
                        val buffer = ByteArray(64 * 1024)
                        var sent = 0L
                        while (true) {
                            operation.checkActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            sink.write(buffer, 0, count)
                            sent += count
                            progress(sent)
                        }
                        sink.flush()
                        progress(identity.size)
                    } finally { operation.detachSource() }
                }
            }
        }
        return request(operation, "PUT", "/api/file-sends/${identity.sendId}/attempts/${identity.attemptId}/content", body, limits.timeoutSeconds)
    }
    fun result(operation: UploadOperation, identity: UploadIdentity): JSONObject =
        request(operation, "GET", "/api/file-sends/${identity.sendId}")
}
