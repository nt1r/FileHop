package top.hammerbilly.filehop

import org.junit.Assert.assertEquals
import org.junit.Test

class FileSaveRulesTest {
    @Test fun specificFileTypeIsNotReplacedByGenericBinary() {
        assertEquals("image/jpeg", FileSaveRules.mimeType("image/jpeg", null))
        assertEquals("application/pdf", FileSaveRules.mimeType("application/pdf", "text/plain"))
    }

    @Test fun missingOrGenericTypeUsesTheOriginalExtensionType() {
        assertEquals("image/png", FileSaveRules.mimeType("application/octet-stream", "image/png"))
        assertEquals("text/plain", FileSaveRules.mimeType("", "text/plain"))
    }

    @Test fun mimeParametersAndCaseAreNormalizedForTheDocumentPicker() {
        assertEquals("text/plain", FileSaveRules.mimeType(" Text/Plain; charset=UTF-8 ", null))
    }

    @Test fun invalidOrUnknownTypesUseSafeFallbacks() {
        assertEquals("application/pdf", FileSaveRules.mimeType("*/*", "application/pdf"))
        assertEquals("image/jpeg", FileSaveRules.mimeType("not a mime type", "image/jpeg"))
        assertEquals("application/octet-stream", FileSaveRules.mimeType("", null))
        assertEquals("application/octet-stream", FileSaveRules.mimeType("", "image/*"))
    }
}
