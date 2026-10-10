package top.hammerbilly.filehop

import org.junit.Assert.*
import org.junit.Test

class TextRulesTest {
    @Test fun onlyAnHttpsDomainRootCanBeConfirmed() {
        assertEquals("https://example.invalid", TextRules.origin("https://example.invalid/"))
        assertEquals("https://example.invalid:8443", TextRules.origin("https://example.invalid:8443"))
        listOf("http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/path",
            "https://example.invalid/../", "https://example.invalid/?q=x", "https://example.invalid/#x",
            "https://example.invalid/?", "https://127.0.0.1", "https://[::1]").forEach { assertNull(it, TextRules.origin(it)) }
    }
    @Test fun textUsesUtf8LimitAndTheSpecifiedWhitespaceSet() {
        assertFalse(TextRules.validText(""))
        assertFalse(TextRules.validText(" \t\n\u0085\u00a0\u3000"))
        assertTrue(TextRules.validText("\u200b"))
        assertTrue(TextRules.validText("\ufeff"))
        assertTrue(TextRules.validText("  text\n  "))
        assertTrue(TextRules.validText("a".repeat(65_536)))
        assertFalse(TextRules.validText("a".repeat(65_537)))
        assertTrue(TextRules.validText("😀".repeat(16_384)))
        assertFalse(TextRules.validText("😀".repeat(16_385)))
    }
    @Test fun labelsNormalizeOnlySpecifiedWhitespaceAndCountCodePoints() {
        assertEquals("Phone", TextRules.label("\u0085 Phone\u3000"))
        assertEquals("\ufeff", TextRules.label("\ufeff"))
        assertNull(TextRules.label(" \n"))
        assertEquals("😀".repeat(64), TextRules.label("😀".repeat(64)))
        assertNull(TextRules.label("😀".repeat(65)))
    }
}
