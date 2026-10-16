package top.hammerbilly.filehop

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource

@Composable
fun FileMessageDownload(message: Message, enabled: Boolean, download: () -> Unit) {
    var confirm by remember { mutableStateOf(false) }
    Text(stringResource(R.string.file_size_bytes, message.fileSize), style = MaterialTheme.typography.bodySmall)
    Text(stringResource(when (message.fileState) {
        "available" -> R.string.file_available
        "storage_error" -> R.string.file_storage_error
        "deleting" -> R.string.file_deleting
        "deleted" -> R.string.file_deleted
        else -> R.string.file_status_unknown
    }), style = MaterialTheme.typography.bodySmall)
    if (message.fileState == "available") {
        TextButton(onClick = { confirm = true }, enabled = enabled) { Text(stringResource(R.string.action_download)) }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false },
        title = { Text(stringResource(R.string.action_download)) },
        text = { Text(stringResource(R.string.download_choose_new_document)) },
        confirmButton = { TextButton(onClick = { confirm = false; download() }, enabled = enabled && message.fileState == "available") {
            Text(stringResource(R.string.action_continue))
        } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.action_cancel)) } })
}

@Composable
fun DownloadFeedback(downloads: FileDownloads) {
    val state = downloads.screen
    Column {
        state.noticeRes?.let { Text(stringResource(it), style = MaterialTheme.typography.bodyMedium) }
        if (state.stage == DownloadStage.Downloading || state.stage == DownloadStage.Saving) {
            Text(stringResource(if (state.stage == DownloadStage.Downloading) R.string.download_receiving else R.string.download_saving))
            LinearProgressIndicator(progress = {
                if (state.total == 0L) 0f else (state.bytes.toDouble() / state.total).toFloat().coerceIn(0f, 1f)
            }, modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.download_progress_bytes, state.bytes, state.total), style = MaterialTheme.typography.labelSmall)
        }
        if (state.stage == DownloadStage.Cancelling) Text(stringResource(R.string.download_cancelling))
        if (state.stage == DownloadStage.Cleaning) Text(stringResource(R.string.download_cleaning))
        Row {
            if (state.stage in listOf(DownloadStage.Waiting, DownloadStage.Downloading, DownloadStage.Saving)) {
                TextButton(onClick = downloads::cancel) { Text(stringResource(R.string.action_cancel)) }
            }
            if (state.cleanupBlocked && !state.busy) {
                TextButton(onClick = downloads::retryCleanup) { Text(stringResource(R.string.action_retry_cleanup)) }
            }
        }
    }
}
