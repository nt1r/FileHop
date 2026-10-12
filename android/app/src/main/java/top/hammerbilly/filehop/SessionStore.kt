package top.hammerbilly.filehop

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Session(val token: String, val localExpiry: Long)

// Only origin, source label and encrypted session are persisted. No passwords, drafts or messages.
class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val alias = "filehop.session"
    private val defaultLabel = context.getString(R.string.default_source_label)
    private fun keys() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val origin: String?
        get() = prefs.getString("origin", null)
    var label: String
        get() = prefs.getString("label", defaultLabel) ?: defaultLabel
        set(value) { check(prefs.edit().putString("label", value).commit()) }
    fun configure(value: String) {
        val valid = requireNotNull(TextRules.origin(value))
        // Destroy the old key before changing origin: even a failed disk write must not
        // make an old token usable with a new server after restart.
        keys().deleteEntry(alias)
        check(prefs.edit().remove("session").putString("origin", valid).commit())
    }
    fun save(session: Session) {
        val key = (keys().getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"
        ).apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val plain = JSONObject().put("token", session.token).put("expiry", session.localExpiry).toString()
        val bytes = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("session", Base64.encodeToString(cipher.iv + bytes, Base64.NO_WRAP)).commit())
    }
    fun load(): Session? {
        val encoded = prefs.getString("session", null) ?: return null
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size > 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keys().getKey(alias, null), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        val value = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        return Session(value.getString("token"), value.getLong("expiry"))
    }
    fun clear() {
        // Destroy the key too: stale ciphertext cannot restore a logged-out session.
        keys().deleteEntry(alias)
        check(prefs.edit().remove("session").commit())
    }
}
