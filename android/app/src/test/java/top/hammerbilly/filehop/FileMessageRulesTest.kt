package top.hammerbilly.filehop

import org.junit.Assert.assertEquals
import org.junit.Test

class FileMessageRulesTest {
    @Test fun statusRefreshCorrectsLoadedHistoryWithoutReorderingOrChangingMetadata() {
        val file = Message(1, "send", "FILE", "", "Android", "", "example.txt", "available", 1,
            fileId = "00000000-0000-0000-0000-000000000001", fileSize = 12, fileMime = "text/plain")
        val text = Message(2, "text-send", "TEXT", "hello", "Android", "", "", "", 0)
        val result = FileMessageRules.correct(listOf(file, text), listOf(
            FileStatus(file.fileId, "deleting", 2),
            FileStatus("00000000-0000-0000-0000-000000000002", "deleted", 9)))

        assertEquals(listOf(file.copy(fileState = "deleting", stateVersion = 2), text), result)
    }

    @Test fun deletedFileCannotBecomeDownloadableFromAnOlderOrEqualVersion() {
        val deleted = Message(1, "send", "FILE", "", "Android", "", "example.txt", "deleted", 3,
            fileId = "00000000-0000-0000-0000-000000000001", fileSize = 12, fileMime = "text/plain")
        val older = deleted.copy(fileState = "available", stateVersion = 1)
        val equal = deleted.copy(fileState = "available")

        assertEquals(listOf(deleted), FileMessageRules.merge(listOf(deleted), listOf(older, equal)))
    }
}
