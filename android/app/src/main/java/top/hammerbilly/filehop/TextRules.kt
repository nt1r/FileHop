package top.hammerbilly.filehop

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object TextRules {
    fun whitespace(c: Char): Boolean = c in '\u0009'..'\u000d' || c == '\u0020' ||
        c == '\u0085' || c == '\u00a0' || c == '\u1680' || c in '\u2000'..'\u200a' ||
        c == '\u2028' || c == '\u2029' || c == '\u202f' || c == '\u205f' || c == '\u3000'
    fun validText(text: String): Boolean = text.any { !whitespace(it) } && text.toByteArray(Charsets.UTF_8).size <= 65_536
    fun label(value: String): String? = value.trim(::whitespace).takeIf { it.codePointCount(0, it.length) in 1..64 }
    fun origin(value: String): String? {
        val raw = value.trim()
        // Reject a syntactically non-root URL before HttpUrl normalizes dot segments.
        val uri = runCatching { java.net.URI(raw) }.getOrNull() ?: return null
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
            uri.rawPath !in listOf("", "/")) return null
        val url = raw.toHttpUrlOrNull() ?: return null
        if (url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty() ||
            url.host.contains(':') || url.host.all { it.isDigit() || it == '.' }) return null
        return url.toString().removeSuffix("/")
    }
}
