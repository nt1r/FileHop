package top.hammerbilly.filehop

data class FileStatus(val fileId: String, val state: String, val version: Long)

/** File availability changes only with a strictly newer server version, including history replies. */
object FileMessageRules {
    fun merge(current: List<Message>, incoming: List<Message>): List<Message> {
        val messages = current.associateBy { it.id }.toMutableMap()
        incoming.forEach { if (it.id !in messages) messages[it.id] = it }
        val statuses = (current + incoming).filter { it.kind == "FILE" }.map {
            FileStatus(it.fileId, it.fileState, it.stateVersion)
        }
        return correct(messages.values.sortedBy { it.id }, statuses)
    }

    fun correct(messages: List<Message>, statuses: List<FileStatus>): List<Message> {
        val latest = mutableMapOf<String, FileStatus>()
        (messages.filter { it.kind == "FILE" }.map { FileStatus(it.fileId, it.fileState, it.stateVersion) } + statuses)
            .forEach { status ->
                if (status.version > (latest[status.fileId]?.version ?: 0)) latest[status.fileId] = status
            }
        return messages.map { message ->
            val status = latest[message.fileId]
            if (message.kind == "FILE" && status != null && status.version > message.stateVersion)
                message.copy(fileState = status.state, stateVersion = status.version)
            else message
        }
    }
}
