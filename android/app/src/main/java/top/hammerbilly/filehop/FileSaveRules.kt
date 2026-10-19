package top.hammerbilly.filehop

import java.util.Locale

object FileSaveRules {
    private const val binary = "application/octet-stream"
    private val concreteType = Regex("[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+")

    // The HTTP download response deliberately uses a generic attachment type; document creation
    // instead needs the file metadata, or its extension when that metadata is absent/generic.
    fun mimeType(declared: String, fromExtension: String?): String {
        fun normalize(value: String?): String? = value?.substringBefore(';')?.trim()
            ?.lowercase(Locale.ROOT)?.takeIf { concreteType.matches(it) && it != binary }
        return normalize(declared) ?: normalize(fromExtension) ?: binary
    }
}
